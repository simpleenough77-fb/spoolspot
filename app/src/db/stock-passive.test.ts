// SPDX-License-Identifier: AGPL-3.0-or-later
// SPOOL-200, migration 0004: boxed stock lines belong at passive storage only.
import { describe, expect, it } from 'vitest';
import { memoryDatabase, memoryDatabaseUpTo, TENANT_A, TENANT_B, uuid } from '../testing.ts';
import { runMigrations } from './migrate.ts';
import { stockOffPassive } from './stock-off-passive.ts';

type Db = ReturnType<typeof memoryDatabase>['db'];

const LEAF_TYPES = ['passive_storage', 'active_storage', 'active_use', 'clip_storage'] as const;

/** A tenant with a container, one leaf of each type and a refillable filament. */
function populate(db: Db, tenant: string): string {
  db.prepare('INSERT INTO tenant_settings (tenant_id) VALUES (?)').run(tenant);
  db.prepare(
    "INSERT INTO location (tenant_id, id, name, type, leaf) VALUES (?, 'room', 'Room', 'container', 0)",
  ).run(tenant);
  for (const type of LEAF_TYPES) {
    const slot = type === 'active_use';
    db.prepare(
      `INSERT INTO location (tenant_id, id, name, type, parent, leaf, capacity, capacity_mode, tag_source)
       VALUES (?, ?, ?, ?, 'room', 1, ?, ?, ?)`,
    ).run(
      tenant,
      type.replace('_', '-'),
      type,
      type,
      slot ? 1 : 5,
      slot ? 'hard' : 'soft',
      slot ? 'holder_post' : 'sticker',
    );
  }
  const f = uuid();
  db.prepare(
    "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, 'Acme', 'PLA', 'Red', 'refillable')",
  ).run(tenant, f);
  return f;
}

const insertLine = (
  db: Db,
  tenant: string,
  f: string,
  location: string,
  pack = 'spool',
  count = 1,
) =>
  db
    .prepare(
      'INSERT INTO stock_line (tenant_id, id, filament_id, location_id, pack, count) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(tenant, uuid(), f, location, pack, count);

describe('migration 0004: boxed stock at passive storage only', () => {
  it('refuses a new stock line at active storage, a slot and clip storage, for both packs', () => {
    const { db } = memoryDatabase();
    const f = populate(db, TENANT_A);
    for (const place of ['active-storage', 'active-use', 'clip-storage']) {
      for (const pack of ['spool', 'refill']) {
        expect(() => insertLine(db, TENANT_A, f, place, pack), `${place} ${pack}`).toThrow(
          /boxed stock belongs at passive storage/,
        );
      }
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM stock_line').get()).toMatchObject({ n: 0 });
  });

  it('still accepts passive storage, and still refuses a container', () => {
    const { db } = memoryDatabase();
    const f = populate(db, TENANT_A);
    insertLine(db, TENANT_A, f, 'passive-storage');
    insertLine(db, TENANT_A, f, 'passive-storage', 'refill', 3);
    expect(() => insertLine(db, TENANT_A, f, 'room')).toThrow(/leaf/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM stock_line').get()).toMatchObject({ n: 2 });
  });

  it('refuses moving a stock line to a non-passive leaf, and an upsert that would start one there', () => {
    const { db } = memoryDatabase();
    const f = populate(db, TENANT_A);
    insertLine(db, TENANT_A, f, 'passive-storage');
    for (const place of ['active-storage', 'active-use', 'clip-storage']) {
      expect(() =>
        db
          .prepare('UPDATE stock_line SET location_id = ? WHERE tenant_id = ?')
          .run(place, TENANT_A),
      ).toThrow(/boxed stock belongs at passive storage/);
    }
    expect(() =>
      db
        .prepare(
          `INSERT INTO stock_line (tenant_id, id, filament_id, location_id, pack, count)
           VALUES (?, ?, ?, 'active-storage', 'spool', 1)
           ON CONFLICT (tenant_id, filament_id, location_id, pack) DO UPDATE SET count = count + 1`,
        )
        .run(TENANT_A, uuid(), f),
    ).toThrow(/boxed stock belongs at passive storage/);
    expect(db.prepare('SELECT location_id FROM stock_line').all()).toEqual([
      { location_id: 'passive-storage' },
    ]);
  });

  it('keeps a passive leaf that holds stock lines passive, and lets an empty one change type', () => {
    const { db } = memoryDatabase();
    const f = populate(db, TENANT_A);
    insertLine(db, TENANT_A, f, 'passive-storage', 'spool', 0);
    expect(() =>
      db
        .prepare("UPDATE location SET type = 'clip_storage' WHERE tenant_id = ? AND id = ?")
        .run(TENANT_A, 'passive-storage'),
    ).toThrow(/boxed stock belongs at passive storage/);
    db.prepare('DELETE FROM stock_line').run();
    db.prepare("UPDATE location SET type = 'clip_storage' WHERE tenant_id = ? AND id = ?").run(
      TENANT_A,
      'passive-storage',
    );
  });

  it('checks the place in the same tenant as the line', () => {
    const { db } = memoryDatabase();
    populate(db, TENANT_A);
    const fb = populate(db, TENANT_B);
    // B's passive leaf is accepted, B's active leaf refused, whatever tenant A has under the same id.
    insertLine(db, TENANT_B, fb, 'passive-storage');
    expect(() => insertLine(db, TENANT_B, fb, 'active-storage')).toThrow(/passive storage/);
  });

  it('runs on a database that already has lines elsewhere, keeps them, lets counts go down, never up', () => {
    const { db } = memoryDatabaseUpTo('0003_event_delete_grant.sql');
    const fa = populate(db, TENANT_A);
    const fb = populate(db, TENANT_B);
    insertLine(db, TENANT_A, fa, 'passive-storage', 'spool', 4);
    insertLine(db, TENANT_A, fa, 'active-storage', 'spool', 2);
    insertLine(db, TENANT_A, fa, 'clip-storage', 'refill', 1);
    insertLine(db, TENANT_B, fb, 'active-use', 'spool', 1);
    const before = db.prepare('SELECT * FROM stock_line ORDER BY rowid').all();

    expect(runMigrations(db)).toEqual(['0004_stock_passive_only.sql']);
    // Nothing deleted or moved.
    expect(db.prepare('SELECT * FROM stock_line ORDER BY rowid').all()).toEqual(before);
    // The listing names exactly the lines off passive storage, per tenant.
    expect(stockOffPassive(db)).toEqual([
      {
        tenant_id: TENANT_A,
        location_id: 'active-storage',
        location_type: 'active_storage',
        filament: 'Acme PLA Red',
        pack: 'spool',
        count: 2,
      },
      {
        tenant_id: TENANT_A,
        location_id: 'clip-storage',
        location_type: 'clip_storage',
        filament: 'Acme PLA Red',
        pack: 'refill',
        count: 1,
      },
      {
        tenant_id: TENANT_B,
        location_id: 'active-use',
        location_type: 'active_use',
        filament: 'Acme PLA Red',
        pack: 'spool',
        count: 1,
      },
    ]);
    // A count change is not a move: it is allowed, so the old line can be cleared.
    db.prepare(
      "UPDATE stock_line SET count = count - 1 WHERE tenant_id = ? AND location_id = 'active-storage'",
    ).run(TENANT_A);
    // Up is refused at the database too.
    expect(() =>
      db
        .prepare(
          "UPDATE stock_line SET count = count + 1 WHERE tenant_id = ? AND location_id = 'active-storage'",
        )
        .run(TENANT_A),
    ).toThrow(/passive storage/);
    // Passive lines still count up.
    db.prepare(
      "UPDATE stock_line SET count = count + 1 WHERE tenant_id = ? AND location_id = 'passive-storage'",
    ).run(TENANT_A);
    // No new line there, of any pack.
    expect(() => insertLine(db, TENANT_A, fa, 'active-storage', 'refill')).toThrow(
      /passive storage/,
    );
    expect(stockOffPassive(db).map((r) => r.count)).toEqual([1, 1, 1]);
  });

  it('lists nothing on a database that follows the rule', () => {
    const { db } = memoryDatabase();
    const f = populate(db, TENANT_A);
    insertLine(db, TENANT_A, f, 'passive-storage');
    expect(stockOffPassive(db)).toEqual([]);
  });
});
