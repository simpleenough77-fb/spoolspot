// SPDX-License-Identifier: AGPL-3.0-or-later
// SPOOL-194: the event log stays append-only in the database; events go only inside a batch that opens
// and closes a grant for one tenant (migration 0003). Tenant deletion uses that path.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Scope } from '../auth/principal.ts';
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
  it('a batch that leaves its grant open fails at commit and deletes nothing', async () => {
    const { db, sql } = await setup();
    await expect(
      sql.batch([
        openGrant(TENANT_A),
        { query: 'DELETE FROM event WHERE tenant_id = ?', params: [TENANT_A] },
      ]),
    ).rejects.toThrow(/FOREIGN KEY/);
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
      tags: 0,
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
  it('only the guarded-delete module, tenant deletion and demo removal use it', () => {
    const allowed = [
      'app/src/data/event-delete.ts',
      'app/src/data/tenant-delete.ts',
      'app/src/seed/demo.ts',
    ];
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|js)$/.test(name) && !name.endsWith('.test.ts')) files.push(path);
      }
    };
    walk('app/src');
    walk('app/public');
    walk('scripts');
    const users = files.filter((f) =>
      /event_delete_grant|guardedEventDelete|deleteTenant|event-delete\.ts|tenant-delete\.ts/.test(
        readFileSync(f, 'utf8'),
      ),
    );
    expect(users.sort()).toEqual(allowed.sort());
  });
});
