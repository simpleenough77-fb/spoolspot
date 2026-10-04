// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { memoryDatabase, readJson, readSeed, SEED_SCHEMA_PATH, TENANT_A, TENANT_B } from '../testing.ts';
import { importSeed, SeedInvalidError } from './import.ts';

const schema = readJson(SEED_SCHEMA_PATH);

function dump(db: ReturnType<typeof memoryDatabase>['db']): string {
  const rows = db.prepare('SELECT * FROM location ORDER BY tenant_id, id').all();
  const settings = db.prepare('SELECT * FROM tenant_settings ORDER BY tenant_id').all();
  return JSON.stringify({ rows, settings });
}

describe('importing locations-seed.json', () => {
  it('creates exactly 81 locations: 54 leaves and 27 containers', async () => {
    const { db, sql } = memoryDatabase();
    const result = await importSeed(sql, TENANT_A, readSeed(), schema);
    expect(result).toEqual({ inserted: 81, skipped: 0 });

    const byType = new Map(
      (
        db
          .prepare(
            'SELECT type, COUNT(*) AS n, SUM(capacity) AS cap FROM location WHERE tenant_id = ? GROUP BY type',
          )
          .all(TENANT_A) as { type: string; n: number; cap: number | null }[]
      ).map((r) => [r.type, r]),
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM location').get()).toMatchObject({ n: 81 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM location WHERE leaf = 1').get()).toMatchObject({ n: 54 });
    expect(byType.get('container')?.n).toBe(27);
    expect(byType.get('active_use')).toMatchObject({ n: 30, cap: 30 });
    expect(byType.get('active_storage')).toMatchObject({ n: 9, cap: 107 });
    expect(byType.get('passive_storage')?.n).toBe(14);
    expect(byType.get('clip_storage')?.n).toBe(1);
  });

  it('keeps the tree intact: one root, parents exist, parents are containers', async () => {
    const { db, sql } = memoryDatabase();
    await importSeed(sql, TENANT_A, readSeed(), schema);
    expect(db.prepare('SELECT COUNT(*) AS n FROM location WHERE parent IS NULL').get()).toMatchObject({ n: 1 });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM location c JOIN location p ON p.tenant_id = c.tenant_id AND p.id = c.parent
            WHERE p.leaf = 1`,
        )
        .get(),
    ).toMatchObject({ n: 0 });
  });

  it('changes nothing when the same seed is imported again', async () => {
    const { db, sql } = memoryDatabase();
    await importSeed(sql, TENANT_A, readSeed(), schema);
    const before = dump(db);
    const again = await importSeed(sql, TENANT_A, readSeed(), schema);
    expect(again).toEqual({ inserted: 0, skipped: 81 });
    expect(dump(db)).toBe(before);
  });

  it('does not overwrite what the user changed since the first import', async () => {
    const { db, sql } = memoryDatabase();
    await importSeed(sql, TENANT_A, readSeed(), schema);
    db.prepare("UPDATE location SET capacity = 25 WHERE tenant_id = ? AND id = 'closet-storage.shelf-1'").run(TENANT_A);
    await importSeed(sql, TENANT_A, readSeed(), schema);
    expect(
      db.prepare("SELECT capacity FROM location WHERE tenant_id = ? AND id = 'closet-storage.shelf-1'").get(TENANT_A),
    ).toMatchObject({ capacity: 25 });
  });

  it('adds only the missing locations when the seed grows', async () => {
    const { db, sql } = memoryDatabase();
    const seed = readSeed();
    const first = { ...seed, locations: seed.locations.slice(0, 40) };
    // The first 40 might leave out parents of later rows, so import a prefix that is closed under parents.
    const ids = new Set(first.locations.map((l) => l.id));
    const closed = seed.locations.filter((l) => l.parent === null || ids.has(l.parent));
    await importSeed(sql, TENANT_A, { ...seed, locations: closed }, schema);
    const result = await importSeed(sql, TENANT_A, seed, schema);
    expect(result.inserted + result.skipped).toBe(81);
    expect(result.inserted).toBe(81 - closed.length);
    expect(db.prepare('SELECT COUNT(*) AS n FROM location').get()).toMatchObject({ n: 81 });
  });

  it('is independent of the order of the rows in the file', async () => {
    const { db, sql } = memoryDatabase();
    const seed = readSeed();
    await importSeed(sql, TENANT_A, { ...seed, locations: [...seed.locations].reverse() }, schema);
    expect(db.prepare('SELECT COUNT(*) AS n FROM location').get()).toMatchObject({ n: 81 });
  });

  it('keeps tenants apart: the same seed for a second tenant adds 81 more', async () => {
    const { db, sql } = memoryDatabase();
    await importSeed(sql, TENANT_A, readSeed(), schema);
    expect(await importSeed(sql, TENANT_B, readSeed(), schema)).toEqual({ inserted: 81, skipped: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM location').get()).toMatchObject({ n: 162 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM tenant_settings').get()).toMatchObject({ n: 2 });
  });

  it('writes nothing when the seed is invalid', async () => {
    const { db, sql } = memoryDatabase();
    const seed = readSeed();
    const broken = { ...seed, locations: seed.locations.map((l, i) => (i === 5 ? { ...l, capacity_mode: 'sometimes' } : l)) };
    await expect(importSeed(sql, TENANT_A, broken, schema)).rejects.toBeInstanceOf(SeedInvalidError);
    expect(db.prepare('SELECT COUNT(*) AS n FROM location').get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM tenant_settings').get()).toMatchObject({ n: 0 });
  });

  it('rejects referential errors the schema cannot see (missing parent, duplicate id)', async () => {
    const { sql } = memoryDatabase();
    const seed = readSeed();
    const orphan = { ...seed, locations: seed.locations.map((l, i) => (i === 3 ? { ...l, parent: 'nowhere' } : l)) };
    await expect(importSeed(sql, TENANT_A, orphan, schema)).rejects.toThrow(/does not exist/);
    const dup = { ...seed, locations: [...seed.locations, seed.locations[2]] };
    await expect(importSeed(sql, TENANT_A, dup, schema)).rejects.toThrow(/duplicate id/);
  });

  it('rolls the whole import back when one row fails in the database', async () => {
    const { db, sql } = memoryDatabase();
    // A tag already used by an unrelated location makes the batch fail partway through.
    db.prepare('INSERT INTO tenant_settings (tenant_id) VALUES (?)').run(TENANT_A);
    db.prepare(
      `INSERT INTO location (tenant_id, id, name, type, leaf, capacity_mode, tag_id, tag_source)
       VALUES (?, 'existing', 'Existing', 'passive_storage', 1, 'soft', '0123456789AB', 'sticker')`,
    ).run(TENANT_A);
    const seed = readSeed();
    const last = seed.locations.length - 1;
    const clash = {
      ...seed,
      locations: seed.locations.map((l, i) => (i === last ? { ...l, tag_id: '0123456789AB' } : l)),
    };
    await expect(importSeed(sql, TENANT_A, clash, schema)).rejects.toThrow(/UNIQUE/i);
    expect(db.prepare('SELECT COUNT(*) AS n FROM location').get()).toMatchObject({ n: 1 });
  });

  it('binds values as parameters: hostile names are stored as plain text', async () => {
    const { db, sql } = memoryDatabase();
    const seed = readSeed();
    const name = "x'); DROP TABLE location; --";
    await importSeed(sql, TENANT_A, { ...seed, locations: seed.locations.map((l, i) => (i === 0 ? { ...l, name } : l)) }, schema);
    expect(db.prepare('SELECT name FROM location WHERE parent IS NULL').get()).toMatchObject({ name });
    expect(db.prepare('SELECT COUNT(*) AS n FROM location').get()).toMatchObject({ n: 81 });
  });
});
