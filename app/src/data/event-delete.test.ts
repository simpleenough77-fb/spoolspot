// SPDX-License-Identifier: AGPL-3.0-or-later
// SPOOL-194: the event log stays append-only in the database; events go only inside a batch that opens
// and closes a grant for one tenant (migration 0003). Tenant deletion uses that path.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Scope } from '../auth/principal.ts';
import { runMigrations } from '../db/migrate.ts';
import { DatabaseIntegrityError, verifyDatabase } from '../db/integrity.ts';
import type { Sql, SqlParam, Statement } from '../db/sql.ts';
import { sqlFromDatabase } from '../db/sqlite.ts';
import { StatementNotAllowedError } from '../db/statement-guard.ts';
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
import { guardedEventDelete } from './event-delete.ts';
import { createScopedData } from './scoped.ts';
import { newTagId } from './tags.ts';
import { deleteTenant } from './tenant-delete.ts';

type Db = ReturnType<typeof memoryDatabase>['db'];

/** A tenant with places, a tag, boxed stock, two filaments, clips and move events. */
async function populate(db: Db, sql: Sql, tenant: string) {
  await importSeed(sql, tenant, readSeed(), readJson(SEED_SCHEMA_PATH));
  const filament = (color: string): string => {
    const id = uuid();
    db.prepare(
      "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, 'Acme', 'PLA', ?, 'refillable')",
    ).run(tenant, id, color);
    return id;
  };
  const red = filament('Red');
  const blue = filament('Blue');
  const clip = (filamentId: string): string => {
    const id = uuid();
    db.prepare(
      "INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, ?, ?, ?, 'loc1.shelf-1', 'on_spool')",
    ).run(tenant, id, newTagId(), filamentId);
    return id;
  };
  const redClip = clip(red);
  const blueClip = clip(blue);
  db.prepare('UPDATE location SET tag_id = ? WHERE tenant_id = ? AND id = ?').run(
    newTagId(),
    tenant,
    'loc1.shelf-2',
  );
  db.prepare(
    "INSERT INTO stock_line (tenant_id, id, filament_id, location_id, pack, count) VALUES (?, ?, ?, 'closet-storage.shelf-1', 'refill', 3)",
  ).run(tenant, uuid(), red);
  const data = createScopedData(sql, {
    subject: tenant,
    tenantId: tenant,
    scopes: new Set([Scope.LocationsRead, Scope.InventoryWrite]),
  });
  for (const id of [redClip, blueClip]) {
    expect(await data.moveClip(id, 'loc1.shelf-2', false)).toMatchObject({ ok: true, moved: true });
  }
  return { red, blue, redClip, blueClip };
}

async function setup() {
  const { db, sql } = memoryDatabase();
  const a = await populate(db, sql, TENANT_A);
  const b = await populate(db, sql, TENANT_B);
  return { db, sql, a, b };
}

/** Every table that holds tenant data, read from the schema so a new table cannot be missed. */
function tenantTables(db: Db): string[] {
  const names = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
  return names.filter((t) =>
    (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some(
      (c) => c.name === 'tenant_id',
    ),
  );
}

function countsFor(db: Db, tenant: string): Record<string, number> {
  return Object.fromEntries(
    tenantTables(db).map((t) => [
      t,
      (
        db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE tenant_id = ?`).get(tenant) as {
          n: number;
        }
      ).n,
    ]),
  );
}

const events = (db: Db, tenant: string): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM event WHERE tenant_id = ?').get(tenant) as { n: number })
    .n;
const grants = (db: Db): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM event_delete_grant').get() as { n: number }).n;
const openGrant = (tenant: string): Statement => ({
  query: "INSERT INTO event_delete_grant (tenant_id, scope) VALUES (?, 'tenant')",
  params: [tenant],
});
const closeGrant = (tenant: string): Statement => ({
  query: "DELETE FROM event_delete_grant WHERE tenant_id = ? AND scope = 'tenant'",
  params: [tenant],
});

/**
 * Since SPOOL-199 the adapter refuses pragmas, schema statements and REPLACE before they run. The
 * database's own defences behind it (triggers, the closing check) are still tested: this adapter runs
 * on a connection where the allowed placeholder `slipped(i)` executes `texts[i]` instead, standing for
 * a statement that got past the allow-list. Test-only; the real adapter has no such path.
 *
 * Every batch through it checks, after it settles, that each forbidden text was prepared and run on
 * the connection; if a placeholder was not swapped the batch fails with that instead, so a test can
 * never pass on the placeholder alone.
 */
function adapterPastTheAllowList(db: Db, texts: readonly string[]): Sql {
  const placeholder = /^SELECT 'slipped (\d+)'$/;
  const swapped = new Set<number>();
  const connection = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') {
        return (query: string) => {
          const m = placeholder.exec(query);
          const text = m ? texts[Number(m[1])] : undefined;
          if (text === undefined) return target.prepare(query);
          swapped.add(Number(m?.[1]));
          return target.prepare(text);
        };
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  const sql = sqlFromDatabase(connection);
  const everySwapped = (): void => {
    const missing = texts.map((_, i) => i).filter((i) => !swapped.has(i));
    if (missing.length > 0) {
      throw new Error(`placeholder not swapped for text ${missing.join(', ')}; nothing was tested`);
    }
  };
  return {
    all: (query, params) => sql.all(query, params),
    async batch(statements) {
      swapped.clear();
      let result: number[];
      try {
        result = await sql.batch(statements);
      } catch (error) {
        everySwapped();
        throw error;
      }
      everySwapped();
      return result;
    },
  };
}
const slipped = (i: number, params?: SqlParam[]): Statement => ({
  query: `SELECT 'slipped ${String(i)}'`,
  ...(params ? { params } : {}),
});

describe('the event log outside a guarded batch', () => {
  it('still refuses DELETE and UPDATE on events', async () => {
    const { db, sql } = await setup();
    expect(() => db.prepare('DELETE FROM event').run()).toThrow(/append-only/);
    await expect(
      sql.batch([{ query: 'DELETE FROM event WHERE tenant_id = ?', params: [TENANT_A] }]),
    ).rejects.toThrow(/append-only/);
    expect(() => db.prepare("UPDATE event SET type = 'retire'").run()).toThrow(/append-only/);
    expect(events(db, TENANT_A)).toBe(2);
    expect(events(db, TENANT_B)).toBe(2);
  });

  it('refuses to replace an event in place, and still takes a new one', async () => {
    const { db, sql } = await setup();
    const [first] = db
      .prepare('SELECT id FROM event WHERE tenant_id = ? ORDER BY rowid LIMIT 1')
      .all(TENANT_A) as { id: string }[];
    const id = first?.id ?? '';
    for (const verb of ['INSERT OR REPLACE INTO', 'REPLACE INTO']) {
      const query = `${verb} event (tenant_id, id, type) VALUES (?, ?, 'retire')`;
      // The adapter refuses REPLACE outright (SPOOL-199)...
      await expect(sql.batch([{ query, params: [TENANT_A, id] }])).rejects.toBeInstanceOf(
        StatementNotAllowedError,
      );
      // ...and the database still refuses it when it gets past the adapter.
      await expect(
        adapterPastTheAllowList(db, [query]).batch([slipped(0, [TENANT_A, id])]),
      ).rejects.toThrow(/append-only/);
    }
    expect(db.prepare('SELECT type FROM event WHERE id = ?').get(id)).toMatchObject({
      type: 'move',
    });
    await sql.batch([
      {
        query: "INSERT INTO event (tenant_id, id, type) VALUES (?, ?, 'intake')",
        params: [TENANT_A, uuid()],
      },
    ]);
    expect(events(db, TENANT_A)).toBe(3);
  });

  it('refuses UPDATE even while a grant is open', async () => {
    const { db, sql } = await setup();
    await expect(
      sql.batch([
        openGrant(TENANT_A),
        { query: "UPDATE event SET type = 'retire' WHERE tenant_id = ?", params: [TENANT_A] },
        closeGrant(TENANT_A),
      ]),
    ).rejects.toThrow(/append-only/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM event WHERE type = 'move'").get()).toMatchObject({
      n: 4,
    });
    expect(grants(db)).toBe(0);
  });

  it('refuses to change a grant, so an open grant cannot be widened to another tenant', async () => {
    const { db, sql } = await setup();
    await expect(
      sql.batch([
        openGrant(TENANT_A),
        {
          query: 'UPDATE event_delete_grant SET tenant_id = ? WHERE tenant_id = ?',
          params: [TENANT_B, TENANT_A],
        },
        { query: 'DELETE FROM event WHERE tenant_id = ?', params: [TENANT_B] },
        closeGrant(TENANT_B),
      ]),
    ).rejects.toThrow(/cannot be changed/);
    expect(events(db, TENANT_B)).toBe(2);
    expect(grants(db)).toBe(0);
  });
});

describe('a grant is tenant-specific and scoped', () => {
  it("a grant for tenant A cannot delete tenant B's events", async () => {
    const { db, sql } = await setup();
    await expect(
      sql.batch([
        openGrant(TENANT_A),
        { query: 'DELETE FROM event WHERE tenant_id = ?', params: [TENANT_B] },
        closeGrant(TENANT_A),
      ]),
    ).rejects.toThrow(/append-only/);
    // Nor by deleting every row: B's rows stop the statement, and nothing of A's goes either.
    await expect(
      sql.batch([openGrant(TENANT_A), { query: 'DELETE FROM event' }, closeGrant(TENANT_A)]),
    ).rejects.toThrow(/append-only/);
    expect(events(db, TENANT_A)).toBe(2);
    expect(events(db, TENANT_B)).toBe(2);
    expect(grants(db)).toBe(0);
  });

  it("a filament grant deletes that filament's events only", async () => {
    const { db, sql, a } = await setup();
    const changed = await sql.batch(
      guardedEventDelete(TENANT_A, { scope: 'filament', filamentId: a.red }),
    );
    expect(changed).toEqual([1, 1, 1]);
    expect(db.prepare('SELECT clip_id FROM event WHERE tenant_id = ?').all(TENANT_A)).toEqual([
      { clip_id: a.blueClip },
    ]);
    // Under a filament grant, another filament's events are still refused.
    await expect(
      sql.batch([
        {
          query:
            "INSERT INTO event_delete_grant (tenant_id, scope, filament_id) VALUES (?, 'filament', ?)",
          params: [TENANT_A, a.red],
        },
        { query: 'DELETE FROM event WHERE tenant_id = ?', params: [TENANT_A] },
        {
          query: "DELETE FROM event_delete_grant WHERE tenant_id = ? AND scope = 'filament'",
          params: [TENANT_A],
        },
      ]),
    ).rejects.toThrow(/append-only/);
    expect(events(db, TENANT_A)).toBe(1);
    expect(events(db, TENANT_B)).toBe(2);
  });

  it('a filament grant matches by the event filament alone and by the clip alone', async () => {
    const { db, sql, a } = await setup();
    const add = db.prepare(
      "INSERT INTO event (tenant_id, id, type, clip_id, filament_id) VALUES (?, ?, 'open', ?, ?)",
    );
    const byFilament = uuid();
    const byClip = uuid();
    add.run(TENANT_A, byFilament, null, a.red); // needs the filament branch of the trigger
    add.run(TENANT_A, byClip, a.redClip, null); // needs the clip branch of the trigger
    await sql.batch(guardedEventDelete(TENANT_A, { scope: 'filament', filamentId: a.red }));
    const left = (
      db.prepare('SELECT id FROM event WHERE tenant_id = ?').all(TENANT_A) as {
        id: string;
      }[]
    ).map((r) => r.id);
    expect(left).not.toContain(byFilament);
    expect(left).not.toContain(byClip);
    expect(left).toHaveLength(1); // the blue clip's move
  });

  it('a filament delete stays in its tenant when another tenant reuses the same ids', async () => {
    const { db, sql, a } = await setup();
    // Ids are unique per tenant only: tenant B may hold a filament and a clip with A's ids.
    db.prepare(
      "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, 'Other', 'PETG', 'Grey', 'disposable')",
    ).run(TENANT_B, a.red);
    db.prepare(
      "INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, ?, ?, ?, 'loc1.shelf-1', 'free')",
    ).run(TENANT_B, a.redClip, newTagId(), a.red);
    db.prepare(
      "INSERT INTO event (tenant_id, id, type, clip_id, filament_id) VALUES (?, ?, 'open', ?, ?)",
    ).run(TENANT_B, uuid(), a.redClip, a.red);
    await sql.batch(guardedEventDelete(TENANT_A, { scope: 'filament', filamentId: a.red }));
    expect(events(db, TENANT_A)).toBe(1);
    expect(events(db, TENANT_B)).toBe(3);
  });

  it("a filament grant cannot name another tenant's filament", async () => {
    const { db, sql, b } = await setup();
    await expect(
      sql.batch(guardedEventDelete(TENANT_A, { scope: 'filament', filamentId: b.red })),
    ).rejects.toThrow(/FOREIGN KEY/);
    expect(events(db, TENANT_B)).toBe(2);
  });

  it('refuses malformed ids before any SQL runs', () => {
    expect(() => guardedEventDelete("a' OR '1'='1", { scope: 'tenant' })).toThrow(/malformed/);
    expect(() => guardedEventDelete(TENANT_A, { scope: 'filament', filamentId: 'x' })).toThrow(
      /malformed/,
    );
  });
});

describe('a grant never outlives its batch', () => {
  it('a batch that leaves its grant open fails and deletes nothing', async () => {
    const { db, sql } = await setup();
    await expect(
      sql.batch([
        openGrant(TENANT_A),
        { query: 'DELETE FROM event WHERE tenant_id = ?', params: [TENANT_A] },
      ]),
    ).rejects.toThrow(/grant left open/);
    expect(events(db, TENANT_A)).toBe(2);
    expect(grants(db)).toBe(0);
  });

  it('the deferred foreign key alone also fails a commit that leaves a grant open', async () => {
    const { db } = await setup();
    // A transaction that skips the closing check: the second closer still stops it at COMMIT.
    db.exec('BEGIN');
    db.prepare("INSERT INTO event_delete_grant (tenant_id, scope) VALUES (?, 'tenant')").run(
      TENANT_A,
    );
    db.prepare('DELETE FROM event WHERE tenant_id = ?').run(TENANT_A);
    expect(() => {
      db.exec('COMMIT');
    }).toThrow(/FOREIGN KEY/);
    db.exec('ROLLBACK');
    expect(events(db, TENANT_A)).toBe(2);
    expect(grants(db)).toBe(0);
  });

  it('a batch that fails midway leaves the grant closed and the events intact', async () => {
    const { db, sql } = await setup();
    await expect(
      sql.batch([
        openGrant(TENANT_A),
        { query: 'DELETE FROM event WHERE tenant_id = ?', params: [TENANT_A] },
        // Fails the batch before the grant is closed (an event id that breaks the table's CHECK).
        {
          query: "INSERT INTO event (tenant_id, id, type) VALUES (?, 'bad', 'intake')",
          params: [TENANT_A],
        },
        closeGrant(TENANT_A),
      ]),
    ).rejects.toThrow(/CHECK/);
    expect(events(db, TENANT_A)).toBe(2);
    expect(grants(db)).toBe(0);
    // No window is left behind: a plain delete straight after is refused again.
    expect(() => db.prepare('DELETE FROM event WHERE tenant_id = ?').run(TENANT_A)).toThrow(
      /append-only/,
    );
  });
});

describe('the closing check does not depend on pragmas (review round 1)', () => {
  it('refuses a batch that turns deferred foreign keys off to keep a grant', async () => {
    const { db, sql } = await setup();
    await expect(
      sql.batch([openGrant(TENANT_A), { query: 'PRAGMA defer_foreign_keys = OFF' }]),
    ).rejects.toBeInstanceOf(StatementNotAllowedError);
    await expect(
      adapterPastTheAllowList(db, ['PRAGMA defer_foreign_keys = OFF']).batch([
        openGrant(TENANT_A),
        slipped(0),
      ]),
    ).rejects.toThrow(/grant left open/);
    expect(grants(db)).toBe(0);
    expect(() => db.prepare('DELETE FROM event').run()).toThrow(/append-only/);
  });

  it('refuses a grant opened after foreign keys were turned off', async () => {
    const { db, sql } = await setup();
    await expect(sql.batch([{ query: 'PRAGMA foreign_keys = OFF' }])).rejects.toBeInstanceOf(
      StatementNotAllowedError,
    );
    db.exec('PRAGMA foreign_keys = OFF');
    await expect(sql.batch([openGrant(TENANT_A)])).rejects.toThrow(/grant left open/);
    expect(grants(db)).toBe(0);
    db.exec('PRAGMA foreign_keys = ON');
  });

  it('refuses a grant that satisfies its foreign key while check constraints are ignored', async () => {
    const { db, sql } = await setup();
    const keepGrant = {
      query:
        "INSERT INTO event_delete_grant (tenant_id, scope, must_close) VALUES (?, 'tenant', 'loc1.shelf-1')",
      params: [TENANT_A],
    };
    await expect(
      sql.batch([{ query: 'PRAGMA ignore_check_constraints = ON' }, keepGrant]),
    ).rejects.toBeInstanceOf(StatementNotAllowedError);
    await expect(
      adapterPastTheAllowList(db, ['PRAGMA ignore_check_constraints = ON']).batch([
        slipped(0),
        keepGrant,
      ]),
    ).rejects.toThrow(/grant left open/);
    db.exec('PRAGMA ignore_check_constraints = OFF');
    expect(grants(db)).toBe(0);
  });

  it('still lets a proper open, delete and close batch through', async () => {
    const { db, sql } = await setup();
    expect(await sql.batch(guardedEventDelete(TENANT_A, { scope: 'tenant' }))).toEqual([1, 2, 1]);
    expect(events(db, TENANT_A)).toBe(0);
    expect(events(db, TENANT_B)).toBe(2);
  });

  it('refuses to start on a database with a grant left behind, or with foreign keys off', async () => {
    const { db } = await setup();
    // A grant written outside any batch, with foreign keys off, is the one case nothing can stop at
    // write time; it is caught before the database is used again.
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare("INSERT INTO event_delete_grant (tenant_id, scope) VALUES (?, 'tenant')").run(
      TENANT_A,
    );
    expect(() => {
      verifyDatabase(db);
    }).toThrow(/foreign keys are not enforced/);
    db.exec('PRAGMA foreign_keys = ON');
    expect(() => {
      verifyDatabase(db);
    }).toThrow(DatabaseIntegrityError);
    expect(() => runMigrations(db)).toThrow(/grant was left open/);
  });

  it('refuses a database whose event log triggers are missing (a partly applied migration)', () => {
    for (const trigger of [
      'event_is_append_only_update',
      'event_is_append_only_delete',
      'event_insert_is_new',
      'event_delete_grant_left_open',
      'event_delete_grant_is_not_updated',
    ]) {
      const { db } = memoryDatabase();
      db.exec(`DROP TRIGGER ${trigger}`);
      expect(() => {
        verifyDatabase(db);
      }, trigger).toThrow(DatabaseIntegrityError);
      expect(() => runMigrations(db), trigger).toThrow(/refusing to use this database/);
    }
  });

  it('accepts a clean database', () => {
    const { db } = memoryDatabase();
    expect(() => {
      verifyDatabase(db);
    }).not.toThrow();
  });
});

describe('temporary tables cannot stand in for the real ones (review round 2)', () => {
  it('a temporary grant table does not hide an open grant from the closing check', async () => {
    const { db, sql } = await setup();
    const texts = [
      'CREATE TEMP TABLE event_delete_grant (tenant_id TEXT)',
      'PRAGMA defer_foreign_keys = OFF',
    ];
    await expect(
      sql.batch([openGrant(TENANT_A), ...texts.map((query) => ({ query }))]),
    ).rejects.toBeInstanceOf(StatementNotAllowedError);
    await expect(
      adapterPastTheAllowList(db, texts).batch([openGrant(TENANT_A), slipped(0), slipped(1)]),
    ).rejects.toThrow(/grant left open/);
    expect(grants(db)).toBe(0);
  });

  it('a temporary closer table does not swallow the closing check', async () => {
    const { db, sql } = await setup();
    const texts = [
      'CREATE TEMP TABLE event_delete_grant_closed (tenant_id TEXT, x INTEGER)',
      'PRAGMA defer_foreign_keys = OFF',
    ];
    await expect(
      sql.batch([openGrant(TENANT_A), ...texts.map((query) => ({ query }))]),
    ).rejects.toBeInstanceOf(StatementNotAllowedError);
    await expect(
      adapterPastTheAllowList(db, texts).batch([openGrant(TENANT_A), slipped(0), slipped(1)]),
    ).rejects.toThrow(/grant left open/);
    expect(grants(db)).toBe(0);
  });

  it('a temporary grant table opens nothing', async () => {
    const { db } = await setup();
    db.exec('CREATE TEMP TABLE event_delete_grant (tenant_id TEXT, scope TEXT, filament_id TEXT)');
    db.prepare("INSERT INTO temp.event_delete_grant VALUES (?, 'tenant', NULL)").run(TENANT_A);
    expect(() => db.prepare('DELETE FROM event WHERE tenant_id = ?').run(TENANT_A)).toThrow(
      /append-only/,
    );
    db.exec('DROP TABLE temp.event_delete_grant');
  });

  it('once a connection has seen the closer, losing it makes every batch fail closed', async () => {
    const { db, sql } = await setup();
    await sql.batch([{ query: 'SELECT 1' }]);
    db.exec('DROP TRIGGER event_delete_grant_left_open');
    db.exec('DROP TABLE event_delete_grant_closed');
    await expect(sql.batch([{ query: 'SELECT 1' }])).rejects.toThrow(/no such table/);
    await expect(sql.batch(guardedEventDelete(TENANT_A, { scope: 'tenant' }))).rejects.toThrow(
      /no such table/,
    );
    expect(events(db, TENANT_A)).toBe(2);
  });

  it('startup still sees a leftover grant behind a temporary table of the same name', async () => {
    const { db } = await setup();
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare("INSERT INTO event_delete_grant (tenant_id, scope) VALUES (?, 'tenant')").run(
      TENANT_A,
    );
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('CREATE TEMP TABLE event_delete_grant (tenant_id TEXT)');
    db.exec('CREATE TEMP TABLE event_delete_grant_closed (tenant_id TEXT, x INTEGER)');
    expect(() => {
      verifyDatabase(db);
    }).toThrow(/grant was left open/);
  });
});

describe('the adapter refuses the review round 2 bypasses before they run (SPOOL-199)', () => {
  const pragma = (db: Db, name: string): unknown =>
    Object.values(db.prepare(`PRAGMA ${name}`).get() as object)[0];
  const has = (db: Db, schema: 'main' | 'temp', type: string, name: string): boolean =>
    db
      .prepare(`SELECT 1 AS n FROM ${schema}.sqlite_master WHERE type = ? AND name = ?`)
      .get(type, name) !== undefined;
  const cases: {
    name: string;
    query: string;
    /** Only `all()` is tested: the same statement in a batch is the sanctioned guarded path. */
    readOnly?: true;
    unchanged: (db: Db) => void;
  }[] = [
    {
      name: 'turning deferred foreign keys off',
      query: 'PRAGMA defer_foreign_keys = OFF',
      unchanged: (db) => {
        expect(pragma(db, 'defer_foreign_keys')).toBe(0);
      },
    },
    {
      name: 'turning foreign keys off',
      query: 'PRAGMA foreign_keys = OFF',
      unchanged: (db) => {
        expect(pragma(db, 'foreign_keys')).toBe(1);
      },
    },
    {
      name: 'ignoring check constraints',
      query: 'PRAGMA ignore_check_constraints = ON',
      unchanged: (db) => {
        expect(pragma(db, 'ignore_check_constraints')).toBe(0);
      },
    },
    {
      name: 'a temporary table named like the grant table',
      query: 'CREATE TEMP TABLE event_delete_grant (tenant_id TEXT, scope TEXT)',
      unchanged: (db) => {
        expect(has(db, 'temp', 'table', 'event_delete_grant')).toBe(false);
      },
    },
    {
      name: 'dropping the trigger that refuses an open grant',
      query: 'DROP TRIGGER event_delete_grant_left_open',
      unchanged: (db) => {
        expect(has(db, 'main', 'trigger', 'event_delete_grant_left_open')).toBe(true);
      },
    },
    {
      name: 'dropping the closer table',
      query: 'DROP TABLE event_delete_grant_closed',
      unchanged: (db) => {
        expect(has(db, 'main', 'table', 'event_delete_grant_closed')).toBe(true);
      },
    },
    {
      name: 'renaming the closer table',
      query: 'ALTER TABLE event_delete_grant_closed RENAME TO kept_open',
      unchanged: (db) => {
        expect(has(db, 'main', 'table', 'event_delete_grant_closed')).toBe(true);
      },
    },
    {
      name: 'a writable schema',
      query: 'PRAGMA writable_schema = ON',
      unchanged: (db) => {
        expect(pragma(db, 'writable_schema')).toBe(0);
      },
    },
    {
      name: 'attaching another database',
      query: "ATTACH DATABASE ':memory:' AS other",
      unchanged: (db) => {
        expect(
          (db.prepare('PRAGMA database_list').all() as { name: string }[]).map((d) => d.name),
        ).not.toContain('other');
      },
    },
    {
      name: 'opening a grant through all()',
      query: "INSERT INTO event_delete_grant (tenant_id, scope) VALUES ('tenant-a', 'tenant')",
      readOnly: true,
      unchanged: () => undefined,
    },
  ];
  for (const c of cases) {
    it(`refuses ${c.name} before it runs`, async () => {
      const { db, sql } = await setup();
      await expect(sql.all(c.query)).rejects.toBeInstanceOf(StatementNotAllowedError);
      if (!c.readOnly) {
        // The grant in front of it is not opened either: a refused batch runs nothing.
        await expect(sql.batch([openGrant(TENANT_A), { query: c.query }])).rejects.toBeInstanceOf(
          StatementNotAllowedError,
        );
      }
      c.unchanged(db);
      expect(grants(db)).toBe(0);
      expect(db.isTransaction).toBe(false);
      expect(() => {
        verifyDatabase(db);
      }).not.toThrow();
      expect(events(db, TENANT_A)).toBe(2);
      // The connection is still usable afterwards.
      await expect(sql.all('SELECT 1 AS n')).resolves.toEqual([{ n: 1 }]);
    });
  }
});

describe('deleteTenant', () => {
  it('removes everything tenant A has, events included, and nothing of tenant B', async () => {
    const { db, sql } = await setup();
    const beforeA = countsFor(db, TENANT_A);
    const beforeB = countsFor(db, TENANT_B);
    expect(beforeA.event).toBe(2);
    const result = await deleteTenant(sql, TENANT_A);
    expect(result).toEqual({
      events: 2,
      stockLines: 1,
      clips: 2,
      filaments: 2,
      locations: beforeA.location,
      orphanTags: 0,
      tenant: 1,
    });
    expect(Object.values(countsFor(db, TENANT_A)).every((n) => n === 0)).toBe(true);
    expect(countsFor(db, TENANT_B)).toEqual(beforeB);
    expect(grants(db)).toBe(0);
    // Append-only holds again after the batch.
    expect(() => db.prepare('DELETE FROM event WHERE tenant_id = ?').run(TENANT_B)).toThrow(
      /append-only/,
    );
  });

  it('deletes nothing when any step fails', async () => {
    const { db, sql } = await setup();
    const beforeA = countsFor(db, TENANT_A);
    const failing: Sql = {
      all: (query, params) => sql.all(query, params),
      batch: (statements) =>
        sql.batch([
          ...statements.slice(0, 2),
          {
            query: "INSERT INTO event (tenant_id, id, type) VALUES (?, 'bad', 'intake')",
            params: [TENANT_A],
          },
          ...statements.slice(2),
        ]),
    };
    await expect(deleteTenant(failing, TENANT_A)).rejects.toThrow();
    expect(countsFor(db, TENANT_A)).toEqual(beforeA);
    expect(grants(db)).toBe(0);
  });

  it('answers zeros for a tenant that does not exist and refuses a malformed id', async () => {
    const { sql } = await setup();
    expect(await deleteTenant(sql, 'tenant-z')).toMatchObject({ events: 0, tenant: 0 });
    await expect(deleteTenant(sql, "' OR 1=1 --")).rejects.toThrow(/malformed/);
  });
});

describe('who can open a grant', () => {
  // A guard against mistakes, not a security control: it catches a grant used from a new place by
  // accident (any letter case, the partial names too), so that place gets reviewed. Code built to hide
  // the names (string building, generated files) would get past it; review and the database triggers
  // are what stop that. It reads the same file list as the SPDX check: every tracked file.
  it('only the guarded-delete modules, tenant deletion and demo removal name the grant', () => {
    const allowed = [
      'app/migrations/0003_event_delete_grant.sql',
      'app/src/data/event-delete.ts',
      'app/src/data/tenant-delete.ts',
      'app/src/db/integrity.ts',
      'app/src/db/sqlite.ts',
      'app/src/seed/demo.ts',
    ];
    const names =
      /event[ _-]?delete|delete[ _-]?grant|grant[ _-]?closed|delete[ _-]?tenant|tenant[ _-]?delete/i;
    const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
      .split('\0')
      .filter((p) => p !== '' && !p.endsWith('.test.ts'));
    expect(tracked.length).toBeGreaterThan(50);
    const users = tracked.filter((f) => names.test(readFileSync(f, 'utf8')));
    expect(users.sort()).toEqual(allowed.sort());
  });
});
