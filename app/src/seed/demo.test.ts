// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createScopedData } from '../data/scoped.ts';
import { Scope } from '../auth/principal.ts';
import { memoryDatabase, readJson, readSeed, SEED_SCHEMA_PATH, TENANT_A, TENANT_B } from '../testing.ts';
import { importSeed } from './import.ts';
import { DEMO_MANUFACTURER, fillDemo, removeDemo } from './demo.ts';
import type { LocationNode } from '../data/tree.ts';

async function setup() {
  const { sql, db } = memoryDatabase();
  await importSeed(sql, TENANT_A, readSeed(), readJson(SEED_SCHEMA_PATH));
  const data = createScopedData(sql, {
    subject: 's',
    tenantId: TENANT_A,
    scopes: new Set([Scope.LocationsRead]),
  });
  return { db, sql, data };
}

function find(nodes: LocationNode[], id: string): LocationNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const inner = find(n.children, id);
    if (inner) return inner;
  }
  return undefined;
}

describe('demo data', () => {
  it('fills the tree so a 16-place shelf shows 10 used and 6 free, one is full, one is over its soft limit', async () => {
    const { db, data } = await setup();
    expect(fillDemo(db, TENANT_A)).toEqual({ clips: 27, stockSpools: 5, alreadyThere: false });
    const tree = await data.locationTree();
    expect(find(tree, 'loc1.shelf-1')).toMatchObject({ used: 10, free: 6 });
    expect(find(tree, 'loc1.shelf-2')).toMatchObject({ used: 16, free: 0 });
    expect(find(tree, 'closet-storage.shelf-1')).toMatchObject({ capacity: 4, used: 5, over: 1 });
    const all = await data.placementSuggestions(1);
    if (all === 'not_found') throw new Error('unexpected');
    const suggested = all.map((s) => s.location_id);
    expect(suggested).not.toContain('loc1.shelf-2');
    expect(suggested).not.toContain('closet-storage.shelf-1');
  });

  it('does nothing the second time', async () => {
    const { db } = await setup();
    fillDemo(db, TENANT_A);
    expect(fillDemo(db, TENANT_A)).toMatchObject({ alreadyThere: true, clips: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM clip').get()).toMatchObject({ n: 27 });
  });

  it('removes exactly what it added and restores the unset capacity', async () => {
    const { db, data } = await setup();
    fillDemo(db, TENANT_A);
    expect(removeDemo(db, TENANT_A)).toBe(27);
    const tree = await data.locationTree();
    expect(find(tree, 'closet-storage.shelf-1')).toMatchObject({ capacity: null, used: 0 });
    expect(tree[0]).toMatchObject({ used: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM filament').get()).toMatchObject({ n: 0 });
    expect(removeDemo(db, TENANT_A)).toBe(0);
  });

  it('leaves a capacity the owner set alone, and another tenant untouched', async () => {
    const { db, sql } = await setup();
    db.prepare("UPDATE location SET capacity = 9 WHERE id = 'closet-storage.shelf-1'").run();
    db.prepare('INSERT INTO tenant_settings (tenant_id) VALUES (?)').run(TENANT_B);
    await importSeed(sql, TENANT_B, readSeed(), readJson(SEED_SCHEMA_PATH));
    fillDemo(db, TENANT_A);
    removeDemo(db, TENANT_A);
    const row = db
      .prepare("SELECT capacity FROM location WHERE id = 'closet-storage.shelf-1' AND tenant_id = ?")
      .get(TENANT_A) as unknown as { capacity: number | null };
    expect(row.capacity).toBe(9);
    expect(db.prepare('SELECT COUNT(*) AS n FROM clip WHERE tenant_id = ?').get(TENANT_B)).toMatchObject({ n: 0 });
  });

  it('does not reset a capacity of 4 that was already there before fill', async () => {
    const { db } = await setup();
    db.prepare("UPDATE location SET capacity = 4 WHERE id = 'closet-storage.shelf-1'").run();
    fillDemo(db, TENANT_A);
    removeDemo(db, TENANT_A);
    const row = db
      .prepare("SELECT capacity FROM location WHERE id = 'closet-storage.shelf-1' AND tenant_id = ?")
      .get(TENANT_A) as unknown as { capacity: number | null };
    expect(row.capacity).toBe(4);
  });

  it('marks everything it adds as demo', async () => {
    const { db } = await setup();
    fillDemo(db, TENANT_A);
    const names = db.prepare('SELECT DISTINCT manufacturer FROM filament').all() as { manufacturer: string }[];
    expect(names).toEqual([{ manufacturer: DEMO_MANUFACTURER }]);
    const tags = db.prepare("SELECT COUNT(*) AS n FROM clip WHERE tag_id LIKE 'DEM0%'").get();
    expect(tags).toMatchObject({ n: 27 });
  });
});
