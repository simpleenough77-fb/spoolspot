// SPDX-License-Identifier: AGPL-3.0-or-later
// SPOOL-134: the shared event write path (ADR-0006). One helper builds the insert; callers add it to
// the same atomic batch as the state change it records.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ForbiddenError, Scope, type Principal } from '../auth/principal.ts';
import type { Sql, Statement } from '../db/sql.ts';
import { importSeed } from '../seed/import.ts';
import {
  memoryDatabase,
  readJson,
  readSeed,
  SEED_SCHEMA_PATH,
  TENANT_A,
  TENANT_B,
  uuid,
} from '../testing.ts';
import * as eventsModule from './events.ts';
import {
  EVENT_TYPES,
  eventInsert,
  guardCondition,
  InvalidEventError,
  type EventGuard,
  type NewEvent,
} from './events.ts';
import { newTagId } from './tags.ts';
import { createScopedData } from './scoped.ts';

const RW = [Scope.LocationsRead, Scope.InventoryWrite];
const principal = (tenantId: string, scopes: string[] = RW): Principal => ({
  subject: `user-of-${tenantId}`,
  tenantId,
  scopes: new Set(scopes),
});

interface EventRow {
  tenant_id: string;
  id: string;
  type: string;
  clip_id: string | null;
  filament_id: string | null;
  from_location_id: string | null;
  to_location_id: string | null;
  occurred_at: string;
}

async function setup() {
  const { sql, db } = memoryDatabase();
  await importSeed(sql, TENANT_A, readSeed(), readJson(SEED_SCHEMA_PATH));
  await importSeed(sql, TENANT_B, readSeed(), readJson(SEED_SCHEMA_PATH));
  const filament = (tenant: string, color: string): string => {
    const id = uuid();
    db.prepare(
      "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, 'Acme', 'PLA', ?, 'disposable')",
    ).run(tenant, id, color);
    return id;
  };
  const clip = (tenant: string, filamentId: string, location: string | null): string => {
    const id = uuid();
    db.prepare(
      "INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, ?, ?, ?, ?, 'on_spool')",
    ).run(tenant, id, newTagId(), filamentId, location);
    return id;
  };
  const redA = filament(TENANT_A, 'Red');
  const clipA = clip(TENANT_A, redA, 'loc1.shelf-1');
  const blueB = filament(TENANT_B, 'Blue');
  const clipB = clip(TENANT_B, blueB, 'loc1.shelf-1');
  const events = (tenant?: string): EventRow[] =>
    (tenant === undefined
      ? db.prepare('SELECT * FROM event ORDER BY rowid').all()
      : db
          .prepare('SELECT * FROM event WHERE tenant_id = ? ORDER BY rowid')
          .all(tenant)) as unknown as EventRow[];
  const locationOf = (id: string): string | null =>
    (
      db.prepare('SELECT location_id FROM clip WHERE id = ?').get(id) as {
        location_id: string | null;
      }
    ).location_id;
  /** Boxed stock that takes `count` places at a location of one tenant. */
  const fill = (tenant: string, location: string, count: number): void => {
    db.prepare(
      "INSERT INTO stock_line (tenant_id, id, filament_id, location_id, pack, count) VALUES (?, ?, ?, ?, 'spool', ?)",
    ).run(tenant, uuid(), filament(tenant, `Fill ${uuid()}`), location, count);
  };
  return { sql, db, redA, clipA, blueB, clipB, events, locationOf, filament, clip, fill };
}

/** Records every batch the data layer sends, then runs it for real. */
function recording(sql: Sql) {
  const batches: (readonly Statement[])[] = [];
  const wrapped: Sql = {
    all: (query, params) => sql.all(query, params),
    batch: (statements) => {
      batches.push(statements);
      return sql.batch(statements);
    },
  };
  return { wrapped, batches };
}

const isEventInsert = (s: Statement): boolean => /^\s*INSERT INTO event\b/.test(s.query);

const moveOf = (clipId: string, from: string | null, to: string): NewEvent => ({
  type: 'move',
  clipId,
  filamentId: null,
  fromLocationId: from,
  toLocationId: to,
});
const stillAt = (from: string | null, to: string, confirm = false): EventGuard => ({
  kind: 'clipStillAt',
  locationId: from,
  hardLimit: { destinationId: to, confirm },
});

// The event table named as a table: bare, "quoted", 'quoted', `quoted` or [bracketed], optionally
// schema-qualified (main.event, "main"."event"). SQL comments and parentheses may sit in between.
const GAP = String.raw`(?:\s|\(|/\*[\s\S]*?\*/|--[^\n]*\n)*`;
const QUALIFIER = String.raw`(?:(?:"[^"]*"|'[^']*'|${'`'}[^${'`'}]*${'`'}|\[[^\]]*\]|[A-Za-z_]\w*)\s*\.\s*)?`;
const EVENT_NAME = String.raw`(?:"event"|'event'|${'`'}event${'`'}|\[event\]|event(?![\w$]))`;
const READS_EVENT = [
  // FROM event, JOIN event
  new RegExp(String.raw`\b(?:FROM|JOIN)(?![\w$])${GAP}${QUALIFIER}${EVENT_NAME}`, 'i'),
  // FROM clip c, event e: a comma join later in the same FROM list
  new RegExp(
    String.raw`\bFROM(?![\w$])(?:(?!\b(?:WHERE|GROUP|ORDER|LIMIT|HAVING|UNION|SELECT|SET|VALUES|ON)\b)[^;()=]){0,200}?,${GAP}${QUALIFIER}${EVENT_NAME}`,
    'i',
  ),
];

function readsEventTable(source: string): boolean {
  return READS_EVENT.some((re) => re.test(source));
}

/** Every non-test source file under app/src, recursively. */
function sourceFiles(dir = 'app/src'): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && !/\.test\.[cm]?[jt]s$/.test(entry.name) ? [path] : [];
  });
}

function eventTableReaders(): string[] {
  return sourceFiles().filter((f) => readsEventTable(readFileSync(f, 'utf8')));
}

describe('the scan for event-table reads (review round 1)', () => {
  it('flags the quoted, bracketed, backticked, schema-qualified and joined forms', () => {
    for (const sql of [
      'SELECT * FROM event',
      'select id from event where tenant_id = ?',
      'SELECT * FROM "event"',
      "SELECT * FROM 'event'",
      'SELECT * FROM `event`',
      'SELECT * FROM [event]',
      'SELECT * FROM main.event',
      'SELECT * FROM main . "event"',
      'SELECT * FROM "main"."event"',
      'SELECT * FROM temp.[event]',
      'SELECT * FROM clip c JOIN [event] e ON e.clip_id = c.id',
      'SELECT * FROM clip c LEFT JOIN main.event e ON 1',
      'SELECT * FROM /* hidden */ event',
      'SELECT * FROM\n  -- note\n  event',
      'SELECT * FROM (event)',
      'SELECT * FROM"event"',
      'SELECT * FROM clip c, event e WHERE e.clip_id = c.id',
      'SELECT * FROM clip c, main."event" e',
      'SELECT * FROM "main"."clip" c, event e',
    ]) {
      expect(readsEventTable(sql), sql).toBe(true);
    }
  });

  it('does not flag the allowed writer or names that only start with event', () => {
    for (const sql of [
      'INSERT INTO event (tenant_id, id) SELECT ?, ?',
      'SELECT * FROM eventual',
      'SELECT * FROM event_by_filament',
      'SELECT * FROM clip c WHERE c.id = ?',
      'SELECT a, event FROM clip',
    ]) {
      expect(readsEventTable(sql), sql).toBe(false);
    }
    expect(readsEventTable(readFileSync('app/src/data/events.ts', 'utf8'))).toBe(false);
  });

  it('walks every non-test file under app/src, nested folders included', () => {
    const files = sourceFiles();
    expect(files).toEqual(
      expect.arrayContaining([
        join('app/src/data/events.ts'),
        join('app/src/http/app.ts'),
        join('app/src/db/migrate.ts'),
        join('app/src/server.ts'),
      ]),
    );
    expect(files.some((f) => f.endsWith('.test.ts'))).toBe(false);
  });
});

describe('eventInsert', () => {
  it('knows exactly the event types of the schema CHECK and schema/event.schema.json', () => {
    const { db } = memoryDatabase();
    const schema = readJson('schema/event.schema.json') as {
      properties: { type: { enum: string[] } };
    };
    expect([...EVENT_TYPES].sort()).toEqual([...schema.properties.type.enum].sort());
    const ddl = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'event'").get() as {
        sql: string;
      }
    ).sql;
    const check = /type IN \(([^)]*)\)/.exec(ddl)?.[1] ?? '';
    const inCheck = [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect([...EVENT_TYPES].sort()).toEqual(inCheck.sort());
  });

  it('rejects an unknown event type before any SQL exists', () => {
    for (const type of ['comment', 'MOVE', '', "move'; DROP TABLE event; --"]) {
      expect(() =>
        eventInsert(principal(TENANT_A), {
          type: type as 'move',
          clipId: null,
          filamentId: null,
          fromLocationId: null,
          toLocationId: null,
        }),
      ).toThrow(InvalidEventError);
    }
  });

  it('rejects free text, a caller-supplied tenant and malformed ids', () => {
    const base = {
      type: 'intake' as const,
      clipId: null,
      filamentId: null,
      fromLocationId: null,
      toLocationId: null,
    };
    const p = principal(TENANT_A);
    expect(() => eventInsert(p, { ...base, note: 'hello' } as typeof base)).toThrow(
      InvalidEventError,
    );
    expect(() => eventInsert(p, { ...base, tenantId: TENANT_B } as typeof base)).toThrow(
      InvalidEventError,
    );
    expect(() => eventInsert(p, { ...base, tenant_id: TENANT_B } as typeof base)).toThrow(
      InvalidEventError,
    );
    expect(() => eventInsert(p, { ...base, clipId: 'not-a-uuid' })).toThrow(InvalidEventError);
    expect(() => eventInsert(p, { ...base, filamentId: 'A'.repeat(36) })).toThrow(
      InvalidEventError,
    );
    expect(() => eventInsert(p, { ...base, toLocationId: 'Shelf 1' })).toThrow(InvalidEventError);
    expect(() => eventInsert(p, { ...base, fromLocationId: '-x' })).toThrow(InvalidEventError);
    expect(() => eventInsert(p, { ...base, clipId: uuid(), filamentId: uuid() })).toThrow(
      InvalidEventError,
    );
  });

  it('needs the inventory write scope', () => {
    expect(() =>
      eventInsert(principal(TENANT_A, [Scope.LocationsRead]), {
        type: 'intake',
        clipId: null,
        filamentId: null,
        fromLocationId: null,
        toLocationId: null,
      }),
    ).toThrow(ForbiddenError);
  });

  it('binds every value as a parameter and takes the tenant from the principal', async () => {
    const s = await setup();
    const hostile = "x'); DELETE FROM clip; --";
    const statement = eventInsert(principal(TENANT_A), {
      type: 'move',
      clipId: s.clipA,
      filamentId: null,
      fromLocationId: 'loc1.shelf-1',
      toLocationId: 'loc1.shelf-2',
    });
    expect(statement.query).not.toContain(TENANT_A);
    expect(statement.query).not.toContain(s.clipA);
    expect(statement.params?.[0]).toBe(TENANT_A);
    // A hostile tenant id is bound like any other value: it never reaches the SQL text.
    const other = eventInsert(principal(hostile), {
      type: 'intake',
      clipId: null,
      filamentId: null,
      fromLocationId: null,
      toLocationId: null,
    });
    expect(other.query).not.toContain(hostile);
  });

  it("writes one event, deriving the filament from the tenant's own clip, with a server timestamp", async () => {
    const s = await setup();
    const before = new Date().toISOString();
    const changed = await s.sql.batch([
      eventInsert(principal(TENANT_A), {
        type: 'move',
        clipId: s.clipA,
        filamentId: null,
        fromLocationId: 'loc1.shelf-1',
        toLocationId: 'loc1.shelf-2',
      }),
    ]);
    expect(changed).toEqual([1]);
    const rows = s.events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: TENANT_A,
      type: 'move',
      clip_id: s.clipA,
      filament_id: s.redA,
      from_location_id: 'loc1.shelf-1',
      to_location_id: 'loc1.shelf-2',
    });
    expect(rows[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(rows[0]?.occurred_at.localeCompare(before)).toBeGreaterThanOrEqual(0);
  });

  it('writes nothing when its guard does not hold', async () => {
    const s = await setup();
    const changed = await s.sql.batch([
      eventInsert(principal(TENANT_A), moveOf(s.clipA, 'loc9.nowhere', 'loc1.shelf-2'), {
        kind: 'clipStillAt',
        locationId: 'loc9.nowhere',
        hardLimit: { destinationId: 'loc1.shelf-2', confirm: false },
      }),
    ]);
    expect(changed).toEqual([0]);
    expect(s.events()).toHaveLength(0);
  });
});

describe('moveClip writes its event through the shared helper', () => {
  it('a move writes exactly one event, in the same batch as the clip change', async () => {
    const s = await setup();
    const { wrapped, batches } = recording(s.sql);
    const result = await createScopedData(wrapped, principal(TENANT_A)).moveClip(
      s.clipA,
      'loc1.shelf-2',
      false,
    );
    expect(result).toMatchObject({ ok: true, moved: true });
    expect(batches).toHaveLength(1);
    const batch = batches[0] ?? [];
    expect(batch.filter(isEventInsert)).toHaveLength(1);
    expect(batch.some((st) => /^\s*UPDATE clip\b/.test(st.query))).toBe(true);
    expect(s.events()).toEqual([
      expect.objectContaining({
        tenant_id: TENANT_A,
        type: 'move',
        clip_id: s.clipA,
        filament_id: s.redA,
        from_location_id: 'loc1.shelf-1',
        to_location_id: 'loc1.shelf-2',
      }),
    ]);
  });

  it('a move that fails inside the transaction writes no event and moves nothing', async () => {
    const s = await setup();
    // Append a statement the database refuses (an event id that breaks its CHECK): the whole batch,
    // the event insert included, must roll back.
    const failing: Sql = {
      all: (query, params) => s.sql.all(query, params),
      batch: (statements) =>
        s.sql.batch([
          ...statements,
          {
            query: "INSERT INTO event (tenant_id, id, type) VALUES (?, 'bad', 'intake')",
            params: [TENANT_A],
          },
        ]),
    };
    await expect(
      createScopedData(failing, principal(TENANT_A)).moveClip(s.clipA, 'loc1.shelf-2', false),
    ).rejects.toThrow();
    expect(s.events()).toHaveLength(0);
    expect(s.locationOf(s.clipA)).toBe('loc1.shelf-1');
  });

  it('a move that loses a race writes no event', async () => {
    const s = await setup();
    // Another request moves the clip between the check and the write: the guard stops both statements.
    const racing: Sql = {
      all: (query, params) => s.sql.all(query, params),
      batch: (statements) => {
        s.db
          .prepare("UPDATE clip SET location_id = 'closet-storage.shelf-1' WHERE id = ?")
          .run(s.clipA);
        return s.sql.batch(statements);
      },
    };
    const result = await createScopedData(racing, principal(TENANT_A)).moveClip(
      s.clipA,
      'loc1.shelf-2',
      false,
    );
    expect(result).toEqual({ ok: false, refusal: 'conflict' });
    expect(s.events()).toHaveLength(0);
  });
});

describe('the event log across tenants', () => {
  it("tenant B cannot write an event against tenant A's clip, filament or places", async () => {
    const s = await setup();
    const b = principal(TENANT_B);
    // B's insert is bound to B's tenant; A's clip does not exist there, so the foreign key refuses it.
    await expect(
      s.sql.batch([
        eventInsert(b, {
          type: 'move',
          clipId: s.clipA,
          filamentId: null,
          fromLocationId: 'loc1.shelf-1',
          toLocationId: 'loc1.shelf-2',
        }),
      ]),
    ).rejects.toThrow(/FOREIGN KEY/);
    await expect(
      s.sql.batch([
        eventInsert(b, {
          type: 'intake',
          clipId: null,
          filamentId: s.redA,
          fromLocationId: null,
          toLocationId: 'closet-storage.shelf-1',
        }),
      ]),
    ).rejects.toThrow(/FOREIGN KEY/);
    // And through the data layer: B cannot move A's clip, so no event is written for it.
    const moved = await createScopedData(s.sql, b).moveClip(s.clipA, 'loc1.shelf-2', false);
    expect(moved).toEqual({ ok: false, refusal: 'clip_not_found' });
    expect(s.events()).toHaveLength(0);
    expect(s.locationOf(s.clipA)).toBe('loc1.shelf-1');
  });

  it("tenant B cannot read tenant A's events through any data-layer path", async () => {
    const s = await setup();
    await createScopedData(s.sql, principal(TENANT_A)).moveClip(s.clipA, 'loc1.shelf-2', false);
    const [eventA] = s.events(TENANT_A);
    expect(eventA).toBeDefined();
    const secrets = [eventA?.id ?? '', s.clipA, s.redA, eventA?.occurred_at ?? ''];

    // Every read the data layer offers today, asked by B with A's ids where an id is taken. The Sql
    // they run on refuses any executed query that names the event table, so a table name built at run
    // time (which the source scan below cannot see) is caught on every path exercised here.
    const eventQueries: string[] = [];
    const watch = (query: string): void => {
      if (readsEventTable(query)) {
        eventQueries.push(query);
        throw new Error('a read path queried the event table');
      }
    };
    const watched: Sql = {
      all: (query, params) => {
        watch(query);
        return s.sql.all(query, params);
      },
      batch: (statements) => {
        for (const st of statements) watch(st.query);
        return s.sql.batch(statements);
      },
    };
    const b = createScopedData(watched, principal(TENANT_B));
    const answers = await Promise.all([
      b.locationSummary(),
      b.locationTree(),
      b.clipsAt('loc1.shelf-2'),
      b.clipsAt('loc1.shelf-1'),
      b.placementCheck('loc1.shelf-2', 1),
      b.placementSuggestions(1),
      b.filaments(),
      b.stockAt('loc1.shelf-2'),
      b.stockOf(s.redA),
      b.resolveTag(eventA?.id ?? ''),
      b.tagView(eventA?.id ?? ''),
    ]);
    expect(eventQueries).toEqual([]);
    const seen = JSON.stringify(answers);
    for (const secret of secrets) expect(seen).not.toContain(secret);
    expect(s.events(TENANT_B)).toHaveLength(0);

    // No module under app/src reads the event table today. A future read path must arrive with its own
    // cross-tenant test (SPOOL-75 gate); this check fails until it does, so it cannot slip in unseen.
    expect(eventTableReaders()).toEqual([]);
  });
});

describe('the event guard is a closed set rendered by the helper (review round 1)', () => {
  it("the reviewer's UNION payload cannot be expressed, at compile time or at run time", async () => {
    const s = await setup();
    const payload = {
      where: "0 UNION ALL SELECT ?, ?, 'retire', NULL, NULL, NULL, NULL",
      params: [TENANT_B, uuid()],
    };
    const intake: NewEvent = {
      type: 'intake',
      clipId: null,
      filamentId: null,
      fromLocationId: null,
      toLocationId: null,
    };
    expect(() =>
      // @ts-expect-error a free-form SQL guard is not an EventGuard
      eventInsert(principal(TENANT_A), intake, payload),
    ).toThrow(InvalidEventError);
    // Smuggled past the types: a `where` next to a valid guard, or a guard of another kind.
    const smuggled = { ...stillAt('loc1.shelf-1', 'loc1.shelf-2'), ...payload } as unknown;
    expect(() =>
      eventInsert(
        principal(TENANT_A),
        moveOf(s.clipA, 'loc1.shelf-1', 'loc1.shelf-2'),
        smuggled as EventGuard,
      ),
    ).toThrow(InvalidEventError);
    expect(() => guardCondition(principal(TENANT_A), s.clipA, smuggled as EventGuard)).toThrow(
      InvalidEventError,
    );
    for (const bad of [
      { ...payload, kind: 'clipStillAt' },
      {
        kind: 'sql',
        locationId: null,
        hardLimit: { destinationId: 'loc1.shelf-2', confirm: false },
      },
      {
        kind: 'clipStillAt',
        locationId: null,
        hardLimit: { destinationId: 'loc1.shelf-2', confirm: 1 },
      },
      {
        kind: 'clipStillAt',
        locationId: "x' OR 1=1 --",
        hardLimit: { destinationId: 'loc1.shelf-2', confirm: false },
      },
      {
        kind: 'clipStillAt',
        locationId: null,
        hardLimit: { destinationId: 'loc1.shelf-2', confirm: false, where: '1' },
      },
      { kind: 'clipStillAt', locationId: null },
      null,
      'EXISTS (SELECT 1)',
    ]) {
      expect(() =>
        eventInsert(
          principal(TENANT_A),
          moveOf(s.clipA, null, 'loc1.shelf-2'),
          bad as unknown as EventGuard,
        ),
      ).toThrow(InvalidEventError);
    }
    expect(s.events()).toHaveLength(0);
  });

  it('exports no way to pass SQL text in: the module surface is exactly this', () => {
    expect(Object.keys(eventsModule).sort()).toEqual(
      ['EVENT_TYPES', 'InvalidEventError', 'eventInsert', 'guardCondition'].sort(),
    );
  });

  it('a guard must say what the event says: clip present, from and to equal', async () => {
    const s = await setup();
    const p = principal(TENANT_A);
    const intake: NewEvent = {
      type: 'intake',
      clipId: null,
      filamentId: s.redA,
      fromLocationId: null,
      toLocationId: 'loc1.shelf-2',
    };
    expect(() => eventInsert(p, intake, stillAt(null, 'loc1.shelf-2'))).toThrow(InvalidEventError);
    const move = moveOf(s.clipA, 'loc1.shelf-1', 'loc1.shelf-2');
    expect(() => eventInsert(p, move, stillAt('loc1.shelf-3', 'loc1.shelf-2'))).toThrow(
      InvalidEventError,
    );
    expect(() => eventInsert(p, move, stillAt('loc1.shelf-1', 'loc1.shelf-3'))).toThrow(
      InvalidEventError,
    );
    expect(() => eventInsert(p, move, stillAt('loc1.shelf-1', 'loc1.shelf-2'))).not.toThrow();
  });

  it("a guard cannot reference another tenant's clip or places", async () => {
    const s = await setup();
    const a = principal(TENANT_A);
    // Tenant B's clip id under principal A: the guard looks only in A, finds nothing, stores nothing.
    expect(
      await s.sql.batch([
        eventInsert(
          a,
          moveOf(s.clipB, 'loc1.shelf-1', 'loc1.shelf-2'),
          stillAt('loc1.shelf-1', 'loc1.shelf-2'),
        ),
      ]),
    ).toEqual([0]);
    expect(s.events()).toHaveLength(0);
    // The hard limit is A's own: B's full shelf does not stop A, A's full shelf does.
    s.fill(TENANT_B, 'loc1.shelf-2', 16);
    expect(
      await s.sql.batch([
        eventInsert(
          a,
          moveOf(s.clipA, 'loc1.shelf-1', 'loc1.shelf-2'),
          stillAt('loc1.shelf-1', 'loc1.shelf-2'),
        ),
      ]),
    ).toEqual([1]);
    s.fill(TENANT_A, 'loc2.shelf-1', 10);
    expect(
      await s.sql.batch([
        eventInsert(
          a,
          moveOf(s.clipA, 'loc1.shelf-1', 'loc2.shelf-1'),
          stillAt('loc1.shelf-1', 'loc2.shelf-1'),
        ),
      ]),
    ).toEqual([0]);
    expect(s.events(TENANT_B)).toHaveLength(0);
    expect(s.events(TENANT_A)).toHaveLength(1);
  });

  it('every statement the helper builds has one bound value per ? and only plain ? placeholders', async () => {
    const s = await setup();
    const p = principal(TENANT_A);
    const built = [
      eventInsert(p, {
        type: 'intake',
        clipId: null,
        filamentId: s.redA,
        fromLocationId: null,
        toLocationId: 'closet-storage.shelf-1',
      }),
      eventInsert(p, moveOf(s.clipA, 'loc1.shelf-1', 'loc1.shelf-2')),
      eventInsert(p, moveOf(s.clipA, null, 'loc1.shelf-2'), stillAt(null, 'loc1.shelf-2')),
      eventInsert(p, moveOf(s.clipA, null, 'loc1.shelf-2'), stillAt(null, 'loc1.shelf-2', true)),
    ];
    const condition = guardCondition(p, s.clipA, stillAt('loc1.shelf-1', 'loc1.shelf-2'));
    for (const st of [...built, { query: condition.sql, params: condition.params }]) {
      expect(st.query.split('?').length - 1).toBe(st.params?.length ?? 0);
      expect(st.query).not.toMatch(/\?\d|[:@$][A-Za-z_]/);
    }
  });

  it('guardCondition needs the inventory write scope', async () => {
    const s = await setup();
    expect(() =>
      guardCondition(
        principal(TENANT_A, [Scope.LocationsRead]),
        s.clipA,
        stillAt('loc1.shelf-1', 'loc1.shelf-2'),
      ),
    ).toThrow(ForbiddenError);
  });

  it('guardCondition returns a frozen condition with frozen params', async () => {
    const s = await setup();
    const condition = guardCondition(
      principal(TENANT_A),
      s.clipA,
      stillAt('loc1.shelf-1', 'loc1.shelf-2'),
    );
    expect(Object.isFrozen(condition) && Object.isFrozen(condition.params)).toBe(true);
    expect(() => {
      (condition.params as unknown[]).push(TENANT_B);
    }).toThrow(TypeError);
  });

  it('renders exactly these query texts, with every value bound and none in the text', async () => {
    const s = await setup();
    const p = principal(TENANT_A);
    const head =
      'INSERT INTO event (tenant_id, id, type, clip_id, filament_id, from_location_id, to_location_id)';
    const guardSql =
      'EXISTS (SELECT 1 FROM clip g WHERE g.tenant_id = ? AND g.id = ? AND g.location_id IS ?' +
      ' AND (? = 1 OR NOT EXISTS (SELECT 1 FROM location d' +
      ' WHERE d.tenant_id = g.tenant_id AND d.id = ?' +
      " AND d.capacity_mode = 'hard' AND d.capacity IS NOT NULL" +
      ' AND COALESCE((SELECT SUM(s.count) FROM stock_line s' +
      ' WHERE s.tenant_id = d.tenant_id AND s.location_id = d.id), 0)' +
      ' + (SELECT COUNT(*) FROM clip k WHERE k.tenant_id = d.tenant_id AND k.location_id = d.id)' +
      ' >= d.capacity)))';
    const clipFilament = '(SELECT k.filament_id FROM clip k WHERE k.tenant_id = ? AND k.id = ?)';
    const noValueInText = (st: { query: string; params?: readonly unknown[] }): void => {
      for (const v of st.params ?? []) {
        if (typeof v === 'string' && v !== '') expect(st.query).not.toContain(v);
      }
    };

    const byFilament = eventInsert(p, {
      type: 'intake',
      clipId: null,
      filamentId: s.redA,
      fromLocationId: null,
      toLocationId: 'closet-storage.shelf-1',
    });
    expect(byFilament.query).toBe(`${head} SELECT ?, ?, ?, ?, ?, ?, ?`);
    expect(byFilament.params).toEqual([
      TENANT_A,
      expect.any(String),
      'intake',
      null,
      s.redA,
      null,
      'closet-storage.shelf-1',
    ]);
    noValueInText(byFilament);

    const byClip = eventInsert(p, moveOf(s.clipA, 'loc1.shelf-1', 'loc1.shelf-2'));
    expect(byClip.query).toBe(`${head} SELECT ?, ?, ?, ?, ${clipFilament}, ?, ?`);
    expect(byClip.params).toEqual([
      TENANT_A,
      expect.any(String),
      'move',
      s.clipA,
      TENANT_A,
      s.clipA,
      'loc1.shelf-1',
      'loc1.shelf-2',
    ]);
    noValueInText(byClip);

    for (const confirm of [false, true]) {
      const guarded = eventInsert(
        p,
        moveOf(s.clipA, null, 'loc1.shelf-2'),
        stillAt(null, 'loc1.shelf-2', confirm),
      );
      expect(guarded.query).toBe(
        `${head} SELECT ?, ?, ?, ?, ${clipFilament}, ?, ? WHERE ${guardSql}`,
      );
      expect(guarded.params).toEqual([
        TENANT_A,
        expect.any(String),
        'move',
        s.clipA,
        TENANT_A,
        s.clipA,
        null,
        'loc1.shelf-2',
        TENANT_A,
        s.clipA,
        null,
        confirm ? 1 : 0,
        'loc1.shelf-2',
      ]);
      noValueInText(guarded);
      const condition = guardCondition(p, s.clipA, stillAt(null, 'loc1.shelf-2', confirm));
      expect(condition.sql).toBe(guardSql);
      expect(condition.params).toEqual([TENANT_A, s.clipA, null, confirm ? 1 : 0, 'loc1.shelf-2']);
      noValueInText({ query: condition.sql, params: condition.params });
    }
  });

  it("derives the filament from the caller's own clip when two tenants share a clip id", async () => {
    const s = await setup();
    // Same clip id in both tenants with different filaments; B's row is stored first.
    const shared = uuid();
    s.db
      .prepare(
        "INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, ?, ?, ?, 'loc1.shelf-1', 'on_spool')",
      )
      .run(TENANT_B, shared, newTagId(), s.blueB);
    s.db
      .prepare(
        "INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, ?, ?, ?, 'loc1.shelf-1', 'on_spool')",
      )
      .run(TENANT_A, shared, newTagId(), s.redA);
    await s.sql.batch([
      eventInsert(principal(TENANT_A), moveOf(shared, 'loc1.shelf-1', 'loc1.shelf-2')),
    ]);
    expect(s.events()).toEqual([
      expect.objectContaining({ tenant_id: TENANT_A, clip_id: shared, filament_id: s.redA }),
    ]);
  });

  it("moveClip's guard ignores another tenant's clip with the same id at the from location", async () => {
    const s = await setup();
    const shared = uuid();
    for (const [tenant, filament] of [
      [TENANT_A, s.redA],
      [TENANT_B, s.blueB],
    ] as const) {
      s.db
        .prepare(
          "INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, ?, ?, ?, 'loc1.shelf-1', 'on_spool')",
        )
        .run(tenant, shared, newTagId(), filament);
    }
    // A's clip is moved away between the read and the write; B's clip of the same id stays put.
    const racing: Sql = {
      all: (query, params) => s.sql.all(query, params),
      batch: (statements) => {
        s.db
          .prepare(
            "UPDATE clip SET location_id = 'closet-storage.shelf-1' WHERE tenant_id = ? AND id = ?",
          )
          .run(TENANT_A, shared);
        return s.sql.batch(statements);
      },
    };
    const result = await createScopedData(racing, principal(TENANT_A)).moveClip(
      shared,
      'loc1.shelf-2',
      false,
    );
    expect(result).toEqual({ ok: false, refusal: 'conflict' });
    expect(s.events()).toHaveLength(0);
    const where = s.db
      .prepare('SELECT tenant_id, location_id FROM clip WHERE id = ? ORDER BY tenant_id')
      .all(shared);
    expect(where).toEqual([
      { tenant_id: TENANT_A, location_id: 'closet-storage.shelf-1' },
      { tenant_id: TENANT_B, location_id: 'loc1.shelf-1' },
    ]);
  });
});

describe('event shape (review round 1)', () => {
  const p = principal(TENANT_A);
  const empty: NewEvent = {
    type: 'intake',
    clipId: null,
    filamentId: null,
    fromLocationId: null,
    toLocationId: null,
  };

  it('a location id may be 64 characters, not 65', () => {
    const at64 = 'a'.repeat(64);
    expect(() => eventInsert(p, { ...empty, toLocationId: at64 })).not.toThrow();
    expect(() => eventInsert(p, { ...empty, fromLocationId: at64 })).not.toThrow();
    expect(() => eventInsert(p, { ...empty, toLocationId: `${at64}a` })).toThrow(InvalidEventError);
    expect(() => eventInsert(p, { ...empty, fromLocationId: `${at64}a` })).toThrow(
      InvalidEventError,
    );
  });

  it('a move needs its clip and its destination; where it came from may be unset', () => {
    const clip = uuid();
    expect(() => eventInsert(p, { ...empty, type: 'move' })).toThrow(InvalidEventError);
    expect(() => eventInsert(p, { ...empty, type: 'move', toLocationId: 'loc1.shelf-2' })).toThrow(
      /needs clipId/,
    );
    expect(() =>
      eventInsert(p, { ...empty, type: 'move', clipId: clip, fromLocationId: 'loc1.shelf-1' }),
    ).toThrow(/needs toLocationId/);
    expect(() => eventInsert(p, moveOf(clip, null, 'loc1.shelf-2'))).not.toThrow();
  });

  it('every field must be present, as an own field', () => {
    const missing: Partial<NewEvent> = { ...empty };
    delete missing.toLocationId;
    expect(() => eventInsert(p, missing as NewEvent)).toThrow(InvalidEventError);
    const inherited = Object.create(empty) as NewEvent;
    expect(() => eventInsert(p, inherited)).toThrow(InvalidEventError);
    const symbolKey: NewEvent = { ...empty, [Symbol('x')]: 1 };
    expect(() => eventInsert(p, symbolKey)).toThrow(InvalidEventError);
  });

  it('reads each field once: a getter cannot pass validation with one value and bind another', () => {
    const clip = uuid();
    let reads = 0;
    const tricky = {
      type: 'move',
      get clipId() {
        reads += 1;
        return reads === 1 ? clip : "x'); DELETE FROM clip; --";
      },
      filamentId: null,
      fromLocationId: null,
      toLocationId: 'loc1.shelf-2',
    } as unknown as NewEvent;
    const statement = eventInsert(p, tricky);
    expect(reads).toBe(1);
    expect(statement.params).toContain(clip);
    expect(statement.params).not.toContain("x'); DELETE FROM clip; --");

    let guardReads = 0;
    const trickyGuard = {
      kind: 'clipStillAt',
      get locationId() {
        guardReads += 1;
        return guardReads === 1 ? null : 'loc1.shelf-9';
      },
      hardLimit: { destinationId: 'loc1.shelf-2', confirm: false },
    } as unknown as EventGuard;
    const guarded = eventInsert(p, moveOf(clip, null, 'loc1.shelf-2'), trickyGuard);
    expect(guardReads).toBe(1);
    expect(guarded.params).not.toContain('loc1.shelf-9');
  });

  it('a missing or non-object event is an InvalidEventError, not a TypeError', () => {
    for (const bad of [null, undefined, 'move', 7, [], [empty]]) {
      expect(() => eventInsert(p, bad as unknown as NewEvent)).toThrow(InvalidEventError);
    }
  });
});

describe('moveClip behaves as on main (review round 1)', () => {
  it('a plain move stores the clip and one event', async () => {
    const s = await setup();
    const result = await createScopedData(s.sql, principal(TENANT_A)).moveClip(
      s.clipA,
      'loc1.shelf-2',
      false,
    );
    expect(result).toMatchObject({ ok: true, moved: true });
    expect(s.locationOf(s.clipA)).toBe('loc1.shelf-2');
    expect(s.events()).toHaveLength(1);
  });

  it('past a hard limit: refused without confirm, stored with it', async () => {
    const s = await setup();
    s.fill(TENANT_A, 'loc1.shelf-2', 16);
    const data = createScopedData(s.sql, principal(TENANT_A));
    expect(await data.moveClip(s.clipA, 'loc1.shelf-2', false)).toMatchObject({
      ok: false,
      refusal: 'needs_confirmation',
    });
    expect(s.events()).toHaveLength(0);
    expect(await data.moveClip(s.clipA, 'loc1.shelf-2', true)).toMatchObject({
      ok: true,
      moved: true,
    });
    expect(s.locationOf(s.clipA)).toBe('loc1.shelf-2');
    expect(s.events()).toEqual([
      expect.objectContaining({ from_location_id: 'loc1.shelf-1', to_location_id: 'loc1.shelf-2' }),
    ]);
  });

  it('a hard limit filled between the check and the write is a conflict', async () => {
    const s = await setup();
    s.fill(TENANT_A, 'loc1.shelf-2', 15);
    const racing: Sql = {
      all: (query, params) => s.sql.all(query, params),
      batch: (statements) => {
        s.fill(TENANT_A, 'loc1.shelf-2', 1);
        return s.sql.batch(statements);
      },
    };
    const result = await createScopedData(racing, principal(TENANT_A)).moveClip(
      s.clipA,
      'loc1.shelf-2',
      false,
    );
    expect(result).toEqual({ ok: false, refusal: 'conflict' });
    expect(s.locationOf(s.clipA)).toBe('loc1.shelf-1');
    expect(s.events()).toHaveLength(0);
  });

  it('a clip that was not placed anywhere moves, and its event has no from', async () => {
    const s = await setup();
    const loose = s.clip(TENANT_A, s.redA, null);
    const result = await createScopedData(s.sql, principal(TENANT_A)).moveClip(
      loose,
      'loc1.shelf-2',
      false,
    );
    expect(result).toMatchObject({ ok: true, moved: true });
    expect(s.locationOf(loose)).toBe('loc1.shelf-2');
    expect(s.events()).toEqual([
      expect.objectContaining({
        clip_id: loose,
        filament_id: s.redA,
        from_location_id: null,
        to_location_id: 'loc1.shelf-2',
      }),
    ]);
  });
});

describe('a clip id the table accepts but the event log refuses (review round 1, SPOOL-197)', () => {
  it('moveClip answers invalid_request, moves nothing and writes no event', async () => {
    const s = await setup();
    // 36 characters of [0-9a-f-]: the clip CHECK accepts it, the canonical UUID check does not.
    const odd = '0123456789abcdef0123456789abcdef----';
    s.db
      .prepare(
        "INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, ?, ?, ?, 'loc1.shelf-1', 'on_spool')",
      )
      .run(TENANT_A, odd, newTagId(), s.redA);
    const result = await createScopedData(s.sql, principal(TENANT_A)).moveClip(
      odd,
      'loc1.shelf-2',
      false,
    );
    expect(result).toEqual({ ok: false, refusal: 'invalid_request' });
    expect(s.locationOf(odd)).toBe('loc1.shelf-1');
    expect(s.events()).toHaveLength(0);
  });
});
