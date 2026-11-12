// SPDX-License-Identifier: AGPL-3.0-or-later
// SPOOL-200, migration 0004: boxed stock lines belong at passive storage only.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  memoryDatabase,
  memoryDatabaseUpTo,
  migrateUpTo,
  TENANT_A,
  TENANT_B,
  uuid,
} from '../testing.ts';
import { runMigrations } from './migrate.ts';
import { openDatabase, openDatabaseReadOnly } from './sqlite.ts';
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

  it("judges a stock line by its own tenant's place, never another tenant's of the same id", () => {
    const { db } = memoryDatabase();
    populate(db, TENANT_A);
    const fb = populate(db, TENANT_B);
    // B holds a line at its passive 'passive-storage'; A has no stock there and retypes its own.
    insertLine(db, TENANT_B, fb, 'passive-storage', 'spool', 1);
    db.prepare(
      "UPDATE location SET type = 'active_storage' WHERE tenant_id = ? AND id = 'passive-storage'",
    ).run(TENANT_A);
    // Insert (trigger 1): B can still start lines at its own passive place.
    const fb2 = uuid();
    db.prepare(
      "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, 'Acme', 'PLA', 'Blue', 'refillable')",
    ).run(TENANT_B, fb2);
    insertLine(db, TENANT_B, fb2, 'passive-storage', 'spool', 1);
    // Update of place, filament or pack (trigger 2): B's line is judged by B's place.
    db.prepare("UPDATE stock_line SET pack = 'refill' WHERE tenant_id = ? AND filament_id = ?").run(
      TENANT_B,
      fb2,
    );
    db.prepare(
      "UPDATE stock_line SET location_id = 'passive-storage' WHERE tenant_id = ? AND filament_id = ?",
    ).run(TENANT_B, fb);
    // Count up (trigger 3): B's line still counts up.
    db.prepare(
      'UPDATE stock_line SET count = count + 1 WHERE tenant_id = ? AND filament_id = ?',
    ).run(TENANT_B, fb);
    expect(
      db
        .prepare('SELECT pack, count FROM stock_line WHERE tenant_id = ? ORDER BY pack')
        .all(TENANT_B),
    ).toEqual([
      { pack: 'refill', count: 1 },
      { pack: 'spool', count: 2 },
    ]);
    // And A is refused at its own, now active, place.
    const fa = (
      db.prepare('SELECT id FROM filament WHERE tenant_id = ?').get(TENANT_A) as { id: string }
    ).id;
    expect(() => insertLine(db, TENANT_A, fa, 'passive-storage')).toThrow(/passive storage/);
  });

  it("lets a tenant retype its own empty place whatever another tenant's same id holds (trigger 4)", () => {
    const { db } = memoryDatabase();
    const fa = populate(db, TENANT_A);
    const fb = populate(db, TENANT_B);
    const retype = (tenant: string) =>
      db
        .prepare(
          "UPDATE location SET type = 'clip_storage' WHERE tenant_id = ? AND id = 'passive-storage'",
        )
        .run(tenant);
    // A holds stock at the id; B's own place there is empty, so B may retype it.
    insertLine(db, TENANT_A, fa, 'passive-storage');
    retype(TENANT_B);
    // A is refused at its own place, which holds stock.
    expect(() => retype(TENANT_A)).toThrow(/passive storage/);
    // The mirror: once A's stock is gone, A may retype even though B now holds stock under the same id
    // on another passive place.
    db.prepare('DELETE FROM stock_line WHERE tenant_id = ?').run(TENANT_A);
    db.prepare(
      "UPDATE location SET type = 'passive_storage' WHERE tenant_id = ? AND id = 'passive-storage'",
    ).run(TENANT_B);
    insertLine(db, TENANT_B, fb, 'passive-storage');
    retype(TENANT_A);
    expect(() => retype(TENANT_B)).toThrow(/passive storage/);
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

    expect(runMigrations(db)).toEqual([
      '0004_stock_passive_only.sql',
      '0005_container_stays_container.sql',
    ]);
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

  it('keeps a line left off passive storage the same line: no new filament or pack, count down only', () => {
    const { db } = memoryDatabaseUpTo('0003_event_delete_grant.sql');
    const fa = populate(db, TENANT_A);
    const other = uuid();
    db.prepare(
      "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, 'Acme', 'PLA', 'Blue', 'refillable')",
    ).run(TENANT_A, other);
    insertLine(db, TENANT_A, fa, 'active-storage', 'spool', 2);
    insertLine(db, TENANT_A, fa, 'passive-storage', 'spool', 1);
    runMigrations(db);
    const at = (place: string) => `tenant_id = '${TENANT_A}' AND location_id = '${place}'`;
    expect(() =>
      db.prepare(`UPDATE stock_line SET pack = 'refill' WHERE ${at('active-storage')}`).run(),
    ).toThrow(/passive storage/);
    expect(() =>
      db.prepare(`UPDATE stock_line SET filament_id = ? WHERE ${at('active-storage')}`).run(other),
    ).toThrow(/passive storage/);
    db.prepare(`UPDATE stock_line SET count = count - 1 WHERE ${at('active-storage')}`).run();
    expect(
      db
        .prepare(`SELECT filament_id, pack, count FROM stock_line WHERE ${at('active-storage')}`)
        .get(),
    ).toEqual({ filament_id: fa, pack: 'spool', count: 1 });
    // On passive storage a line may still change pack or filament.
    db.prepare(`UPDATE stock_line SET pack = 'refill' WHERE ${at('passive-storage')}`).run();
    db.prepare(`UPDATE stock_line SET filament_id = ? WHERE ${at('passive-storage')}`).run(other);
    expect(
      db.prepare(`SELECT filament_id, pack FROM stock_line WHERE ${at('passive-storage')}`).get(),
    ).toEqual({ filament_id: other, pack: 'refill' });
    // The line left off passive storage may be moved onto a passive place.
    db.prepare(
      `UPDATE stock_line SET location_id = 'passive-storage' WHERE ${at('active-storage')}`,
    ).run();
    expect(
      db
        .prepare(
          `SELECT filament_id, pack, count FROM stock_line WHERE ${at('passive-storage')} ORDER BY pack`,
        )
        .all(),
    ).toEqual([
      { filament_id: other, pack: 'refill', count: 1 },
      { filament_id: fa, pack: 'spool', count: 1 },
    ]);
    expect(stockOffPassive(db)).toEqual([]);
  });

  it('reads through the WAL while the server has the database open, and still refuses writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spoolspot-ro-'));
    try {
      const path = join(dir, 'spoolspot.db');
      // The server's connection stays open, so -wal and -shm exist and new commits sit in the WAL.
      const server = openDatabase(path);
      runMigrations(server);
      const f = populate(server, TENANT_A);
      insertLine(server, TENANT_A, f, 'passive-storage', 'spool', 1);
      expect(readdirSync(dir).sort()).toEqual([
        'spoolspot.db',
        'spoolspot.db-shm',
        'spoolspot.db-wal',
      ]);
      const mainBytes = readFileSync(path);
      const reader = openDatabaseReadOnly(path);
      try {
        expect(() => {
          reader.exec("INSERT INTO tenant_settings (tenant_id) VALUES ('intruder')");
        }).toThrow(/readonly/);
        const count = () =>
          (reader.prepare('SELECT COUNT(*) AS n FROM stock_line').get() as { n: number }).n;
        expect(count()).toBe(1);
        // A commit the server makes afterwards is seen (not an immutable snapshot).
        insertLine(server, TENANT_A, f, 'passive-storage', 'refill', 1);
        expect(count()).toBe(2);
      } finally {
        reader.close();
      }
      expect(readFileSync(path).equals(mainBytes)).toBe(true);
      expect(
        server
          .prepare("SELECT COUNT(*) AS n FROM tenant_settings WHERE tenant_id = 'intruder'")
          .get(),
      ).toMatchObject({ n: 0 });
      server.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the listing script reads without changing the database file or creating side files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spoolspot-ro-'));
    try {
      const path = join(dir, 'data', 'spoolspot.db');
      // A database closed cleanly by the app, with one line off passive storage from before 0004.
      const old = openDatabase(path);
      migrateUpTo(old, '0003_event_delete_grant.sql');
      const f = populate(old, TENANT_A);
      insertLine(old, TENANT_A, f, 'active-storage', 'spool', 2);
      runMigrations(old);
      old.close();
      const files = () => readdirSync(join(dir, 'data')).sort();
      const before = { bytes: readFileSync(path), mode: statSync(path).mode, files: files() };
      expect(before.files).toEqual(['spoolspot.db']);
      const run = spawnSync(process.execPath, ['scripts/stock-off-passive.ts'], {
        env: { ...process.env, SPOOLSPOT_DB: path },
        encoding: 'utf8',
      });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('active-storage (active_storage): Acme PLA Red, spool, count 2');
      expect(files()).toEqual(before.files);
      expect(statSync(path).mode).toBe(before.mode);
      expect(readFileSync(path).equals(before.bytes)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opens a database read only: every write is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spoolspot-ro-'));
    try {
      const path = join(dir, 'x.db');
      const db = openDatabase(path);
      runMigrations(db);
      db.close();
      const ro = openDatabaseReadOnly(path);
      expect(() => {
        ro.exec("INSERT INTO tenant_settings (tenant_id) VALUES ('x')");
      }).toThrow(/readonly/);
      ro.close();
      expect(() => openDatabaseReadOnly(join(dir, 'missing.db'))).toThrow(/no database/);
      expect(readdirSync(dir)).toEqual(['x.db']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists nothing on a database that follows the rule', () => {
    const { db } = memoryDatabase();
    const f = populate(db, TENANT_A);
    insertLine(db, TENANT_A, f, 'passive-storage');
    expect(stockOffPassive(db)).toEqual([]);
  });
});
