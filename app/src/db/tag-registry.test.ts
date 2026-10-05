// SPDX-License-Identifier: AGPL-3.0-or-later
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
import { runMigrations } from './migrate.ts';
import { openDatabase } from './sqlite.ts';

type Db = ReturnType<typeof memoryDatabase>['db'];

const TAG_1 = '0123456789AB';
const TAG_2 = 'CDEFGHJKMNPQ';

function tenant(db: Db, id: string): void {
  db.prepare('INSERT INTO tenant_settings (tenant_id) VALUES (?)').run(id);
}

function shelf(db: Db, t: string, id: string, tag: string | null = null): void {
  db.prepare(
    `INSERT INTO location (tenant_id, id, name, type, leaf, capacity, capacity_mode, tag_id, tag_source)
     VALUES (?, ?, ?, 'passive_storage', 1, 5, 'soft', ?, 'sticker')`,
  ).run(t, id, id, tag);
}

function filament(db: Db, t: string): string {
  const id = uuid();
  db.prepare(
    "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, 'M', 'PLA', 'Red', 'refillable')",
  ).run(t, id);
  return id;
}

function clip(db: Db, t: string, f: string, tag: string): string {
  const id = uuid();
  db.prepare(
    "INSERT INTO clip (tenant_id, id, tag_id, filament_id, state) VALUES (?, ?, ?, ?, 'free')",
  ).run(t, id, tag, f);
  return id;
}

function tags(db: Db, t: string): unknown[] {
  return db
    .prepare('SELECT tag_id, kind, target_id FROM tag WHERE tenant_id = ? ORDER BY tag_id')
    .all(t);
}

describe('tag registry (SPOOL-177)', () => {
  it('refuses the same tag ID on a location and a clip in one tenant, both ways round', () => {
    const { db } = memoryDatabase();
    tenant(db, TENANT_A);
    const f = filament(db, TENANT_A);
    shelf(db, TENANT_A, 'one', TAG_1);
    expect(() => clip(db, TENANT_A, f, TAG_1)).toThrow(/UNIQUE/i);
    clip(db, TENANT_A, f, TAG_2);
    expect(() => {
      shelf(db, TENANT_A, 'two', TAG_2);
    }).toThrow(/UNIQUE/i);
    expect(() =>
      db.prepare('UPDATE location SET tag_id = ? WHERE id = ?').run(TAG_2, 'one'),
    ).toThrow(/UNIQUE/i);
    // The refused writes left nothing behind.
    expect(db.prepare('SELECT COUNT(*) AS n FROM clip').get()).toMatchObject({ n: 1 });
    expect(tags(db, TENANT_A)).toHaveLength(2);
  });

  it('lets two tenants use the same tag ID', () => {
    const { db } = memoryDatabase();
    tenant(db, TENANT_A);
    tenant(db, TENANT_B);
    shelf(db, TENANT_A, 'one', TAG_1);
    shelf(db, TENANT_B, 'one', TAG_1);
    clip(db, TENANT_B, filament(db, TENANT_B), TAG_2);
    expect(tags(db, TENANT_A)).toEqual([{ tag_id: TAG_1, kind: 'location', target_id: 'one' }]);
    expect(tags(db, TENANT_B)).toHaveLength(2);
  });

  it('keeps the registry in step when a tag is set, changed, cleared and the record deleted', () => {
    const { db } = memoryDatabase();
    tenant(db, TENANT_A);
    shelf(db, TENANT_A, 'one');
    expect(tags(db, TENANT_A)).toEqual([]);
    db.prepare('UPDATE location SET tag_id = ? WHERE id = ?').run(TAG_1, 'one');
    expect(tags(db, TENANT_A)).toEqual([{ tag_id: TAG_1, kind: 'location', target_id: 'one' }]);
    db.prepare('UPDATE location SET tag_id = ? WHERE id = ?').run(TAG_2, 'one');
    expect(tags(db, TENANT_A)).toEqual([{ tag_id: TAG_2, kind: 'location', target_id: 'one' }]);
    db.prepare('UPDATE location SET tag_id = NULL WHERE id = ?').run('one');
    expect(tags(db, TENANT_A)).toEqual([]);
    db.prepare('UPDATE location SET tag_id = ? WHERE id = ?').run(TAG_1, 'one');
    db.prepare('DELETE FROM location WHERE id = ?').run('one');
    expect(tags(db, TENANT_A)).toEqual([]);

    const f = filament(db, TENANT_A);
    const id = clip(db, TENANT_A, f, TAG_1);
    expect(tags(db, TENANT_A)).toEqual([{ tag_id: TAG_1, kind: 'clip', target_id: id }]);
    db.prepare('UPDATE clip SET tag_id = ? WHERE id = ?').run(TAG_2, id);
    expect(tags(db, TENANT_A)).toEqual([{ tag_id: TAG_2, kind: 'clip', target_id: id }]);
    db.prepare('DELETE FROM clip WHERE id = ?').run(id);
    expect(tags(db, TENANT_A)).toEqual([]);
  });

  it('moves the registry row when a record changes its ID', () => {
    const { db } = memoryDatabase();
    tenant(db, TENANT_A);
    shelf(db, TENANT_A, 'one', TAG_1);
    db.prepare('UPDATE location SET id = ? WHERE id = ?').run('uno', 'one');
    expect(tags(db, TENANT_A)).toEqual([{ tag_id: TAG_1, kind: 'location', target_id: 'uno' }]);
    // An update that changes nothing leaves the registry alone.
    db.prepare('UPDATE location SET name = ? WHERE id = ?').run('Renamed', 'uno');
    expect(tags(db, TENANT_A)).toEqual([{ tag_id: TAG_1, kind: 'location', target_id: 'uno' }]);
  });

  it('never replaces a location or clip row in place, which would skip the delete triggers', () => {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (
          /\.(ts|js|sql)$/.test(entry.name) &&
          !entry.name.endsWith('tag-registry.test.ts')
        ) {
          const text = readFileSync(path, 'utf8');
          if (/(INSERT\s+OR\s+REPLACE|REPLACE\s+INTO)\s+(INTO\s+)?(location|clip)\b/i.test(text)) {
            found.push(path);
          }
        }
      }
    };
    for (const dir of ['app/src', 'app/migrations', 'scripts']) walk(dir);
    expect(found).toEqual([]);
  });

  it('stops the migration, changing nothing, when a location and a clip share a tag ID', () => {
    const old = openDatabase(':memory:');
    runMigrationsUpTo(old, new URL('../../migrations/', import.meta.url).pathname, '0001_init.sql');
    tenant(old, TENANT_A);
    shelf(old, TENANT_A, 'one', TAG_1);
    clip(old, TENANT_A, filament(old, TENANT_A), TAG_1);
    expect(() => runMigrations(old)).toThrow(/UNIQUE/i);
    const names = old.prepare('SELECT name FROM sqlite_master WHERE name = ?').all('tag');
    expect(names).toEqual([]);
    expect(old.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toMatchObject({
      n: 1,
    });
  });

  it('rejects a malformed tag ID in the registry itself', () => {
    const { db } = memoryDatabase();
    tenant(db, TENANT_A);
    const add = db.prepare(
      "INSERT INTO tag (tenant_id, tag_id, kind, target_id) VALUES (?, ?, 'location', 'x')",
    );
    for (const bad of ['short', '0123456789ab', '0123456789AI', `${TAG_1}\u0000`, `${TAG_1}A`]) {
      expect(() => add.run(TENANT_A, bad), bad).toThrow();
    }
  });

  it('rejects a registry row for a tenant that does not exist', () => {
    const { db } = memoryDatabase();
    expect(() =>
      db
        .prepare(
          "INSERT INTO tag (tenant_id, tag_id, kind, target_id) VALUES ('nobody', ?, 'clip', 'x')",
        )
        .run(TAG_1),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('moves existing tags into the registry when the migration runs on a populated database', () => {
    // A database that stopped at 0001: no registry yet, with tags already in use.
    const old = openDatabase(':memory:');
    const dir = new URL('../../migrations/', import.meta.url).pathname;
    // Apply only 0001 by migrating a copy of the folder that holds just that file.
    runMigrationsUpTo(old, dir, '0001_init.sql');
    old.prepare('INSERT INTO tenant_settings (tenant_id) VALUES (?)').run(TENANT_A);
    old
      .prepare(
        `INSERT INTO location (tenant_id, id, name, type, leaf, capacity, capacity_mode, tag_id, tag_source)
         VALUES (?, 'one', 'one', 'passive_storage', 1, 5, 'soft', ?, 'sticker')`,
      )
      .run(TENANT_A, TAG_1);
    const f = uuid();
    old
      .prepare(
        "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, 'M', 'PLA', 'Red', 'refillable')",
      )
      .run(TENANT_A, f);
    const c = uuid();
    old
      .prepare(
        "INSERT INTO clip (tenant_id, id, tag_id, filament_id, state) VALUES (?, ?, ?, ?, 'free')",
      )
      .run(TENANT_A, c, TAG_2, f);
    runMigrations(old);
    expect(tags(old, TENANT_A)).toEqual([
      { tag_id: TAG_1, kind: 'location', target_id: 'one' },
      { tag_id: TAG_2, kind: 'clip', target_id: c },
    ]);
  });

  it('leaves the seed import untouched: 81 locations, and the registry matches their tags', async () => {
    const { db, sql } = memoryDatabase();
    tenant(db, TENANT_A);
    const result = await importSeed(sql, TENANT_A, readSeed(), readJson(SEED_SCHEMA_PATH));
    expect(result.inserted).toBe(81);
    const tagged = db
      .prepare('SELECT COUNT(*) AS n FROM location WHERE tag_id IS NOT NULL')
      .get() as unknown as { n: number };
    expect(db.prepare('SELECT COUNT(*) AS n FROM tag').get()).toMatchObject({ n: tagged.n });
  });
});

function runMigrationsUpTo(db: Db, dir: string, last: string): void {
  const tmp = mkdtempSync(join(tmpdir(), 'spoolspot-mig-'));
  try {
    copyFileSync(join(dir, last), join(tmp, last));
    runMigrations(db, tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
