// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createScopedData } from '../data/scoped.ts';
import { Scope } from '../auth/principal.ts';
import { memoryDatabase, readJson, readSeed, SEED_SCHEMA_PATH, TENANT_A, TENANT_B } from '../testing.ts';
import { importSeed } from './import.ts';
import { DEMO_MANUFACTURER, DemoRemovalRefused, fillDemo, removeDemo } from './demo.ts';
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

  it('tags three places for phone demos, resolvable per tenant, and remove clears them', async () => {
    const { db, sql } = await setup();
    fillDemo(db, TENANT_A);
    const data = createScopedData(sql, {
      subject: 's',
      tenantId: TENANT_A,
      scopes: new Set([Scope.LocationsRead]),
    });
    expect(await data.resolveTag('DEM100000001')).toMatchObject({ kind: 'location' });
    expect(await data.tagView('DEM100000003')).toMatchObject({
      kind: 'location',
      location: { id: 'closet-storage.shelf-1' },
    });
    removeDemo(db, TENANT_A);
    expect(await data.resolveTag('DEM100000001')).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM tag').get()).toMatchObject({ n: 0 });
  });

  it('never replaces a tag a place already has', async () => {
    const { db } = await setup();
    db.prepare(
      "UPDATE location SET tag_id = 'SKQT0000AAAA' WHERE tenant_id = ? AND id = 'loc1.shelf-1'",
    ).run(TENANT_A);
    fillDemo(db, TENANT_A);
    removeDemo(db, TENANT_A);
    expect(
      db.prepare("SELECT tag_id FROM location WHERE id = 'loc1.shelf-1'").get(),
    ).toMatchObject({ tag_id: 'SKQT0000AAAA' });
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

  it('removes the demo after a demo clip was moved (SPOOL-194), and only the demo events', async () => {
    const { db, sql } = await setup();
    fillDemo(db, TENANT_A);
    const writer = createScopedData(sql, {
      subject: 's',
      tenantId: TENANT_A,
      scopes: new Set([Scope.LocationsRead, Scope.InventoryWrite]),
    });
    const [demoClip] = db
      .prepare("SELECT id FROM clip WHERE tenant_id = ? AND location_id = 'loc1.shelf-1' LIMIT 1")
      .all(TENANT_A) as { id: string }[];
    const moved = await writer.moveClip(demoClip?.id ?? '', 'closet-storage.shelf-1', false);
    expect(moved).toMatchObject({ ok: true, moved: true });
    // A real event of the same tenant, not about the demo, must survive the removal.
    db.prepare("INSERT INTO event (tenant_id, id, type, to_location_id) VALUES (?, ?, 'intake', 'loc1.shelf-1')").run(
      TENANT_A,
      '00000000-0000-4000-8000-0000000d0001',
    );
    expect(removeDemo(db, TENANT_A)).toBe(27);
    expect(db.prepare('SELECT COUNT(*) AS n FROM clip').get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM filament').get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT id FROM event').all()).toEqual([
      { id: '00000000-0000-4000-8000-0000000d0001' },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM event_delete_grant').get()).toMatchObject({ n: 0 });
  });

  describe('never removes what is not the demo (review round 1)', () => {
    type Db = Awaited<ReturnType<typeof setup>>['db'];
    const writer = (sql: Awaited<ReturnType<typeof setup>>['sql']) =>
      createScopedData(sql, {
        subject: 's',
        tenantId: TENANT_A,
        scopes: new Set([Scope.LocationsRead, Scope.InventoryWrite]),
      });
    /** A person's own filament that happens to carry the demo manufacturer name, with a moved clip. */
    async function userLookalike(
      db: Db,
      sql: Awaited<ReturnType<typeof setup>>['sql'],
      color: string,
    ) {
      const filament = '00000000-0000-4000-8000-00000000f001';
      db.prepare(
        "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, ?, 'PLA', ?, 'disposable')",
      ).run(TENANT_A, filament, DEMO_MANUFACTURER, color);
      const clip = '00000000-0000-4000-8000-00000000c001';
      db.prepare(
        "INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, ?, ?, ?, 'loc1.shelf-1', 'on_spool')",
      ).run(TENANT_A, clip, 'SKQT0000C001', filament);
      expect(await writer(sql).moveClip(clip, 'closet-storage.shelf-1', false)).toMatchObject({
        ok: true,
      });
      return { filament, clip };
    }
    const snapshot = (db: Db) =>
      ['filament', 'clip', 'event', 'stock_line', 'tag'].map(
        (t) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
      );

    it('leaves a user filament named like the demo alone when there is no demo', async () => {
      const { db, sql } = await setup();
      await userLookalike(db, sql, 'Galaxy');
      const before = snapshot(db);
      expect(removeDemo(db, TENANT_A)).toBe(0);
      expect(snapshot(db)).toEqual(before);
    });

    it('refuses, changing nothing, when the demo fingerprint matches a filament with real clips', async () => {
      const { db, sql } = await setup();
      await userLookalike(db, sql, 'Demo');
      const before = snapshot(db);
      expect(() => removeDemo(db, TENANT_A)).toThrow(DemoRemovalRefused);
      expect(snapshot(db)).toEqual(before);
    });

    it('removes only the demo when a lookalike user filament is there too', async () => {
      const { db, sql } = await setup();
      const user = await userLookalike(db, sql, 'Galaxy');
      fillDemo(db, TENANT_A);
      expect(removeDemo(db, TENANT_A)).toBe(27);
      expect(db.prepare('SELECT id FROM filament').all()).toEqual([{ id: user.filament }]);
      expect(db.prepare('SELECT id FROM clip').all()).toEqual([{ id: user.clip }]);
      expect(db.prepare('SELECT clip_id FROM event').all()).toEqual([{ clip_id: user.clip }]);
    });

    it('refuses when an event names a demo clip with another filament, or the demo filament with no clip', async () => {
      // Rule: demo removal deletes an event only when its clip is a demo clip and its filament is the
      // demo filament (or empty). Anything else touching the demo is not demo history: stop, change nothing.
      for (const variant of ['real filament, demo clip', 'demo filament, no clip'] as const) {
        const { db, sql } = await setup();
        const user = await userLookalike(db, sql, 'Galaxy');
        fillDemo(db, TENANT_A);
        const demo = db
          .prepare(
            "SELECT c.id AS clip, c.filament_id AS filament FROM clip c WHERE c.tag_id LIKE 'DEM0%' LIMIT 1",
          )
          .get() as { clip: string; filament: string };
        db.prepare(
          "INSERT INTO event (tenant_id, id, type, clip_id, filament_id) VALUES (?, '00000000-0000-4000-8000-00000000e001', 'open', ?, ?)",
        ).run(
          TENANT_A,
          variant === 'real filament, demo clip' ? demo.clip : null,
          variant === 'real filament, demo clip' ? user.filament : demo.filament,
        );
        const before = snapshot(db);
        expect(() => removeDemo(db, TENANT_A), variant).toThrow(DemoRemovalRefused);
        expect(snapshot(db), variant).toEqual(before);
      }
    });
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
