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
import { EVENT_TYPES, eventInsert, InvalidEventError } from './events.ts';
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
  return { sql, db, redA, clipA, blueB, clipB, events, locationOf };
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
      eventInsert(
        principal(TENANT_A),
        {
          type: 'move',
          clipId: s.clipA,
          filamentId: null,
          fromLocationId: 'loc1.shelf-1',
          toLocationId: 'loc1.shelf-2',
        },
        {
          where: 'EXISTS (SELECT 1 FROM clip WHERE tenant_id = ? AND id = ? AND location_id IS ?)',
          params: [TENANT_A, s.clipA, 'loc9.nowhere'],
        },
      ),
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

    // Every read the data layer offers today, asked by B with A's ids where an id is taken.
    const b = createScopedData(s.sql, principal(TENANT_B));
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
    const seen = JSON.stringify(answers);
    for (const secret of secrets) expect(seen).not.toContain(secret);
    expect(s.events(TENANT_B)).toHaveLength(0);

    // No data-layer module reads the event table today. A future read path must arrive with its own
    // cross-tenant test (SPOOL-75 gate); this check fails until it does, so it cannot slip in unseen.
    const dir = 'app/src/data';
    const readers = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => /\b(FROM|JOIN)\s+event\b/i.test(readFileSync(join(dir, f), 'utf8')));
    expect(readers).toEqual([]);
  });
});
