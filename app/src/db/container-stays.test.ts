// SPDX-License-Identifier: AGPL-3.0-or-later
// SPOOL-198, migration 0005: a container never becomes a leaf, tagged or not, with children or not.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { memoryDatabase, memoryDatabaseUpTo, migrateUpTo, TENANT_A, TENANT_B } from '../testing.ts';
import { leafTagDesync } from './leaf-tag-desync.ts';
import { runMigrations } from './migrate.ts';
import { openDatabase } from './sqlite.ts';

type Db = ReturnType<typeof memoryDatabase>['db'];

const TAG_ROOM = 'C0NTA1NER001';
const TAG_EMPTY = 'C0NTA1NER002';
const TAG_SHELF = 'C0NTA1NER003';
const LEAF_TYPES = ['passive_storage', 'active_storage', 'active_use', 'clip_storage'] as const;
const REFUSED = /a container stays a container/;

/**
 * A tenant with: 'room' (container, tagged, with a child), 'box' (container, untagged, with a child),
 * 'empty' (container, tagged, no children), 'bare' (container, untagged, no children), and 'shelf', a
 * tagged passive leaf inside 'box'. A container's tag is a registry row only.
 */
function populate(db: Db, tenant: string): void {
  db.prepare('INSERT INTO tenant_settings (tenant_id) VALUES (?)').run(tenant);
  const container = db.prepare(
    "INSERT INTO location (tenant_id, id, name, type, parent, leaf) VALUES (?, ?, ?, 'container', ?, 0)",
  );
  container.run(tenant, 'room', 'Room', null);
  container.run(tenant, 'box', 'Box', 'room');
  container.run(tenant, 'empty', 'Empty', null);
  container.run(tenant, 'bare', 'Bare', null);
  db.prepare(
    `INSERT INTO location (tenant_id, id, name, type, parent, leaf, capacity, capacity_mode, tag_id, tag_source)
     VALUES (?, 'shelf', 'Shelf', 'passive_storage', 'box', 1, 5, 'soft', ?, 'sticker')`,
  ).run(tenant, TAG_SHELF);
  const tag = db.prepare(
    "INSERT INTO tag (tenant_id, tag_id, kind, target_id) VALUES (?, ?, 'location', ?)",
  );
  tag.run(tenant, TAG_ROOM, 'room');
  tag.run(tenant, TAG_EMPTY, 'empty');
}

/** A complete, otherwise valid change of a place into a leaf of `type`: only the rule can refuse it. */
function toLeaf(db: Db, tenant: string, id: string, type = 'passive_storage'): void {
  const slot = type === 'active_use';
  db.prepare(
    `UPDATE location SET type = ?, leaf = 1, capacity = ?, capacity_mode = ?, tag_source = ?
      WHERE tenant_id = ? AND id = ?`,
  ).run(type, slot ? 1 : 5, slot ? 'hard' : 'soft', slot ? 'holder_post' : 'sticker', tenant, id);
}

/** A complete change of a leaf into a container (0001's CHECKs need the leaf-only columns cleared). */
function toContainer(db: Db, tenant: string, id: string): void {
  db.prepare(
    `UPDATE location SET type = 'container', leaf = 0, capacity = NULL, capacity_mode = NULL,
            tag_id = NULL, tag_source = NULL
      WHERE tenant_id = ? AND id = ?`,
  ).run(tenant, id);
}

const snapshot = (db: Db) => ({
  location: db.prepare('SELECT * FROM location ORDER BY tenant_id, id').all(),
  tag: db.prepare('SELECT * FROM tag ORDER BY tenant_id, tag_id').all(),
});

const leafOf = (db: Db, tenant: string, id: string) =>
  db.prepare('SELECT type, leaf FROM location WHERE tenant_id = ? AND id = ?').get(tenant, id);

describe('migration 0005: a container never becomes a leaf', () => {
  it('refuses a tagged container with no children, into every leaf type, and changes nothing', () => {
    const { db } = memoryDatabase();
    populate(db, TENANT_A);
    const before = snapshot(db);
    for (const type of LEAF_TYPES) {
      expect(() => {
        toLeaf(db, TENANT_A, 'empty', type);
      }, type).toThrow(REFUSED);
    }
    expect(snapshot(db)).toEqual(before);
  });

  it('refuses an untagged container with no children (empty)', () => {
    const { db } = memoryDatabase();
    populate(db, TENANT_A);
    expect(() => {
      toLeaf(db, TENANT_A, 'bare');
    }).toThrow(REFUSED);
    expect(leafOf(db, TENANT_A, 'bare')).toEqual({ type: 'container', leaf: 0 });
  });

  it('refuses a container with children, tagged or not (0001 refused these already)', () => {
    const { db } = memoryDatabase();
    populate(db, TENANT_A);
    const before = snapshot(db);
    for (const id of ['room', 'box']) {
      // Either rule's message: both triggers refuse, and which runs first is SQLite's choice.
      expect(() => {
        toLeaf(db, TENANT_A, id);
      }, id).toThrow(/stays? a container/);
    }
    expect(snapshot(db)).toEqual(before);
  });

  it('refuses setting leaf or type alone too', () => {
    const { db } = memoryDatabase();
    populate(db, TENANT_A);
    for (const q of [
      "UPDATE location SET leaf = 1 WHERE tenant_id = ? AND id = 'bare'",
      "UPDATE location SET type = 'clip_storage' WHERE tenant_id = ? AND id = 'bare'",
    ]) {
      expect(() => db.prepare(q).run(TENANT_A), q).toThrow(REFUSED);
    }
  });

  it('still lets a container be updated otherwise (name, parent, same type)', () => {
    const { db } = memoryDatabase();
    populate(db, TENANT_A);
    db.prepare(
      "UPDATE location SET name = 'Renamed', parent = 'room', type = 'container', leaf = 0 WHERE tenant_id = ? AND id = 'empty'",
    ).run(TENANT_A);
    expect(
      db
        .prepare("SELECT name, parent FROM location WHERE tenant_id = ? AND id = 'empty'")
        .get(TENANT_A),
    ).toEqual({ name: 'Renamed', parent: 'room' });
  });

  it('leaves leaf to container as it was: allowed for an empty leaf (its tag is dropped), refused while it holds a clip', () => {
    const { db } = memoryDatabase();
    populate(db, TENANT_A);
    // Today (0001): an empty leaf may become a container; clearing tag_id makes 0002 drop its registry row.
    toContainer(db, TENANT_A, 'shelf');
    expect(leafOf(db, TENANT_A, 'shelf')).toEqual({ type: 'container', leaf: 0 });
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM tag WHERE tenant_id = ? AND tag_id = ?')
        .get(TENANT_A, TAG_SHELF),
    ).toEqual({ n: 0 });
    // And once a container, it stays one.
    expect(() => {
      toLeaf(db, TENANT_A, 'shelf');
    }).toThrow(REFUSED);
    // A leaf that holds a clip stays a leaf (0001, unchanged).
    const { db: db2 } = memoryDatabase();
    populate(db2, TENANT_A);
    db2
      .prepare(
        "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, '00000000-0000-4000-8000-0000000000f1', 'Acme', 'PLA', 'Red', 'disposable')",
      )
      .run(TENANT_A);
    db2
      .prepare(
        "INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, '00000000-0000-4000-8000-0000000000c1', 'C0NTA1NER004', '00000000-0000-4000-8000-0000000000f1', 'shelf', 'on_spool')",
      )
      .run(TENANT_A);
    expect(() => {
      toContainer(db2, TENANT_A, 'shelf');
    }).toThrow(/must stay a leaf/);
  });

  it("judges each tenant's row by itself: another tenant's same-id container or leaf never decides", () => {
    const { db } = memoryDatabase();
    populate(db, TENANT_A);
    populate(db, TENANT_B);
    // B turns its empty leaf 'shelf' into a container; A's 'shelf' is still a leaf.
    toContainer(db, TENANT_B, 'shelf');
    // A's leaf, same id as B's container, can still change between leaf types.
    for (const type of ['clip_storage', 'active_storage', 'passive_storage']) {
      toLeaf(db, TENANT_A, 'shelf', type);
    }
    expect(leafOf(db, TENANT_A, 'shelf')).toEqual({ type: 'passive_storage', leaf: 1 });
    // And B's container is refused, though A's same-id row is a leaf.
    expect(() => {
      toLeaf(db, TENANT_B, 'shelf');
    }).toThrow(REFUSED);
    expect(leafOf(db, TENANT_B, 'shelf')).toEqual({ type: 'container', leaf: 0 });
    // A's refused change leaves B's same-id container untouched, and the reverse.
    expect(() => {
      toLeaf(db, TENANT_A, 'empty');
    }).toThrow(REFUSED);
    expect(leafOf(db, TENANT_B, 'empty')).toEqual({ type: 'container', leaf: 0 });
  });

  it('the trigger is the rule: without it a tagged empty container becomes a leaf with a registry-only tag', () => {
    // Shows the state this migration prevents (a migration runs before 0005 here).
    const { db } = memoryDatabaseUpTo('0004_stock_passive_only.sql');
    populate(db, TENANT_A);
    toLeaf(db, TENANT_A, 'empty');
    expect(leafTagDesync(db)).toEqual([
      { tenant_id: TENANT_A, location_id: 'empty', registry_tag: TAG_EMPTY, column_tag: null },
    ]);
  });
});

describe('existing databases: leaves with a registry-only tag are kept and listed', () => {
  it('runs on a database that already has such a leaf, changes no row, and lists it per tenant', () => {
    const { db } = memoryDatabaseUpTo('0004_stock_passive_only.sql');
    populate(db, TENANT_A);
    populate(db, TENANT_B);
    toLeaf(db, TENANT_A, 'empty');
    toLeaf(db, TENANT_B, 'bare');
    const before = snapshot(db);
    expect(runMigrations(db)).toEqual(['0005_container_stays_container.sql']);
    expect(snapshot(db)).toEqual(before);
    // B's 'bare' was untagged, so it has nothing out of step; A's 'empty' kept its registry row.
    expect(leafTagDesync(db)).toEqual([
      { tenant_id: TENANT_A, location_id: 'empty', registry_tag: TAG_EMPTY, column_tag: null },
    ]);
    // A leaf from before stays a leaf and may change leaf type; it never goes back the other way here.
    toLeaf(db, TENANT_A, 'empty', 'clip_storage');
    expect(() => {
      toLeaf(db, TENANT_A, 'room');
    }).toThrow(/stays? a container/);
  });

  it('lists nothing on a database that follows the rule', () => {
    const { db } = memoryDatabase();
    populate(db, TENANT_A);
    expect(leafTagDesync(db)).toEqual([]);
  });

  it('the listing script reads without changing the database file or creating side files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spoolspot-ro-'));
    try {
      const path = join(dir, 'spoolspot.db');
      const old = openDatabase(path);
      migrateUpTo(old, '0004_stock_passive_only.sql');
      populate(old, TENANT_A);
      toLeaf(old, TENANT_A, 'empty');
      runMigrations(old);
      old.close();
      const before = { bytes: readFileSync(path), files: readdirSync(dir).sort() };
      expect(before.files).toEqual(['spoolspot.db']);
      const run = spawnSync(process.execPath, ['scripts/leaf-tag-desync.ts'], {
        env: { ...process.env, SPOOLSPOT_DB: path },
        encoding: 'utf8',
      });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain(`empty: registry tag ${TAG_EMPTY}, column empty`);
      expect(readdirSync(dir).sort()).toEqual(before.files);
      expect(readFileSync(path).equals(before.bytes)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
