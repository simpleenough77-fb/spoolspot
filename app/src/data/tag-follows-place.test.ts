// SPDX-License-Identifier: AGPL-3.0-or-later
// SPOOL-198, migration 0005 (owner decision 2026-11-12): a tag goes with its place. A move (a parent
// change) leaves every tag, clip and stock line as it was; a rename (an id change) takes the place's
// tag with it, for a container (registry row only) as for a leaf (tag_id column). Every test starts
// from a database migrated to 0004 that already holds tagged containers and leaves, then applies 0005.
import { describe, expect, it } from 'vitest';
import { Scope, type Principal } from '../auth/principal.ts';
import { runMigrations } from '../db/migrate.ts';
import { memoryDatabaseUpTo, TENANT_A, TENANT_B } from '../testing.ts';
import { createScopedData, type TagView } from './scoped.ts';

type Db = ReturnType<typeof memoryDatabaseUpTo>['db'];

const T = {
  closet1: 'F0110WTAG001',
  closet2: 'F0110WTAG002',
  cart: 'F0110WTAG003',
  shelf: 'F0110WTAG004',
  clipBox: 'F0110WTAG005',
  bin: 'F0110WTAG006',
  clipA: 'F0110WTAG007',
  clipB: 'F0110WTAG008',
  spare: 'F0110WTAG009',
} as const;
const FILAMENT = '00000000-0000-4000-8000-00000000f001';
const CLIP_A = '00000000-0000-4000-8000-00000000c001';
const CLIP_B = '00000000-0000-4000-8000-00000000c002';
const STOCK = '00000000-0000-4000-8000-00000000a001';

/**
 * One tenant's tree, the same ids and tag IDs in every tenant (tag IDs are unique per tenant only):
 *   closet-1 (container, tagged)
 *     cart (container, tagged)
 *       shelf (passive leaf, tagged, one stock line)
 *       bin (clip storage leaf, tagged, empty)
 *     clip-box (clip storage leaf, tagged, two clips)
 *   closet-2 (container, tagged)
 *   spare-room (container, untagged, empty)
 *   spare-box (container, tagged, empty)
 */
function populate(db: Db, tenant: string): void {
  db.prepare('INSERT INTO tenant_settings (tenant_id) VALUES (?)').run(tenant);
  const container = db.prepare(
    "INSERT INTO location (tenant_id, id, name, type, parent, leaf) VALUES (?, ?, ?, 'container', ?, 0)",
  );
  container.run(tenant, 'closet-1', 'Closet 1', null);
  container.run(tenant, 'closet-2', 'Closet 2', null);
  container.run(tenant, 'cart', 'Cart', 'closet-1');
  container.run(tenant, 'spare-room', 'Spare room', null);
  container.run(tenant, 'spare-box', 'Spare box', null);
  const leaf = db.prepare(
    `INSERT INTO location (tenant_id, id, name, type, parent, leaf, capacity, capacity_mode, tag_id, tag_source)
     VALUES (?, ?, ?, ?, ?, 1, 10, 'soft', ?, 'sticker')`,
  );
  leaf.run(tenant, 'shelf', 'Shelf', 'passive_storage', 'cart', T.shelf);
  leaf.run(tenant, 'bin', 'Bin', 'clip_storage', 'cart', T.bin);
  leaf.run(tenant, 'clip-box', 'Clip box', 'clip_storage', 'closet-1', T.clipBox);
  const tag = db.prepare(
    "INSERT INTO tag (tenant_id, tag_id, kind, target_id) VALUES (?, ?, 'location', ?)",
  );
  tag.run(tenant, T.closet1, 'closet-1');
  tag.run(tenant, T.closet2, 'closet-2');
  tag.run(tenant, T.cart, 'cart');
  tag.run(tenant, T.spare, 'spare-box');
  db.prepare(
    "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, 'Acme', 'PLA', 'Red', 'disposable')",
  ).run(tenant, FILAMENT);
  const clip = db.prepare(
    "INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, ?, ?, ?, 'clip-box', 'free')",
  );
  clip.run(tenant, CLIP_A, T.clipA, FILAMENT);
  clip.run(tenant, CLIP_B, T.clipB, FILAMENT);
  db.prepare(
    "INSERT INTO stock_line (tenant_id, id, filament_id, location_id, pack, count) VALUES (?, ?, ?, 'shelf', 'spool', 3)",
  ).run(tenant, STOCK, FILAMENT);
}

/** Tenants A and B on a database built at 0004, then migrated through 0005. */
function setup() {
  const { db, sql } = memoryDatabaseUpTo('0004_stock_passive_only.sql');
  populate(db, TENANT_A);
  populate(db, TENANT_B);
  expect(runMigrations(db)).toEqual(['0005_container_stays_container.sql']);
  const principal = (tenantId: string): Principal => ({
    subject: tenantId,
    tenantId,
    scopes: new Set([Scope.LocationsRead, Scope.InventoryWrite]),
  });
  const data = (tenant: string) => createScopedData(sql, principal(tenant));
  const rows = (tenant: string) => ({
    location: db
      .prepare('SELECT id, parent, leaf, tag_id FROM location WHERE tenant_id = ? ORDER BY id')
      .all(tenant),
    tag: db
      .prepare('SELECT tag_id, kind, target_id FROM tag WHERE tenant_id = ? ORDER BY tag_id')
      .all(tenant),
    clip: db
      .prepare('SELECT id, tag_id, location_id, state FROM clip WHERE tenant_id = ? ORDER BY id')
      .all(tenant),
    stock: db
      .prepare(
        'SELECT id, location_id, pack, count FROM stock_line WHERE tenant_id = ? ORDER BY id',
      )
      .all(tenant),
  });
  const registryTarget = (tenant: string, tagId: string) =>
    (
      db
        .prepare('SELECT target_id FROM tag WHERE tenant_id = ? AND tag_id = ?')
        .get(tenant, tagId) as { target_id: string } | undefined
    )?.target_id ?? null;
  const move = (tenant: string, id: string, parent: string | null) =>
    db
      .prepare('UPDATE location SET parent = ? WHERE tenant_id = ? AND id = ?')
      .run(parent, tenant, id);
  const rename = (tenant: string, id: string, to: string) =>
    db.prepare('UPDATE location SET id = ? WHERE tenant_id = ? AND id = ?').run(to, tenant, id);
  return { db, sql, data, rows, registryTarget, move, rename };
}

/** Where each tag points, as tagView shows it: the location or clip id. */
async function resolved(
  data: ReturnType<typeof setup>['data'],
  tenant: string,
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const [name, tag] of Object.entries(T)) {
    const view: TagView | null = await data(tenant).tagView(tag);
    out[name] = view === null ? null : view.kind === 'clip' ? view.clip.id : view.location.id;
  }
  return out;
}

const BEFORE_MOVE = {
  closet1: 'closet-1',
  closet2: 'closet-2',
  cart: 'cart',
  shelf: 'shelf',
  clipBox: 'clip-box',
  bin: 'bin',
  clipA: CLIP_A,
  clipB: CLIP_B,
  spare: 'spare-box',
};

describe('a move (parent change) keeps every tag, clip and stock line', () => {
  it('moves a tagged container with tagged leaves, clips and stock inside: only the parent changes', async () => {
    const { data, rows, move } = setup();
    const before = rows(TENANT_A);
    expect(await resolved(data, TENANT_A)).toEqual(BEFORE_MOVE);
    move(TENANT_A, 'cart', 'closet-2');
    const after = rows(TENANT_A);
    expect(after.tag).toEqual(before.tag);
    expect(after.clip).toEqual(before.clip);
    expect(after.stock).toEqual(before.stock);
    expect(after.location).toEqual(
      before.location.map((l) =>
        (l as { id: string }).id === 'cart' ? { ...l, parent: 'closet-2' } : l,
      ),
    );
    // Every tag still resolves to the same place or clip.
    expect(await resolved(data, TENANT_A)).toEqual(BEFORE_MOVE);
    // Reported under the new parent: in the tree, and in the new parent's container view.
    const tree = await data(TENANT_A).locationTree();
    const closet2 = tree.find((n) => n.id === 'closet-2');
    expect(closet2?.children.map((n) => n.id)).toEqual(['cart']);
    expect(closet2?.children[0]?.children.map((n) => n.id)).toEqual(['shelf', 'bin']);
    const view = await data(TENANT_A).tagView(T.closet2);
    expect(view?.kind === 'container' ? view.inside.map((l) => l.id) : null).toEqual([
      'shelf',
      'bin',
    ]);
    const old = await data(TENANT_A).tagView(T.closet1);
    expect(old?.kind === 'container' ? old.inside.map((l) => l.id) : null).toEqual(['clip-box']);
  });

  it('moves a tagged leaf holding clips (a clip box from one closet to another)', async () => {
    const { data, rows, move } = setup();
    const before = rows(TENANT_A);
    move(TENANT_A, 'clip-box', 'closet-2');
    const after = rows(TENANT_A);
    expect(after.tag).toEqual(before.tag);
    expect(after.clip).toEqual(before.clip);
    expect(await resolved(data, TENANT_A)).toEqual(BEFORE_MOVE);
    const view = await data(TENANT_A).tagView(T.clipBox);
    expect(view).toMatchObject({ kind: 'location', location: { id: 'clip-box', used: 2 } });
    const closet2 = (await data(TENANT_A).locationTree()).find((n) => n.id === 'closet-2');
    expect(closet2?.children.map((n) => n.id)).toEqual(['clip-box']);
  });

  it("keeps 0001's rules: no cycle, and the parent must be a container", () => {
    const { rows, move } = setup();
    const before = rows(TENANT_A);
    expect(() => move(TENANT_A, 'closet-1', 'cart')).toThrow(/own ancestor/);
    expect(() => move(TENANT_A, 'clip-box', 'shelf')).toThrow(/parent must be a container/);
    expect(rows(TENANT_A)).toEqual(before);
  });

  it("never touches another tenant's same-id rows or same tag IDs", async () => {
    const { data, rows, move } = setup();
    const b = rows(TENANT_B);
    move(TENANT_A, 'cart', 'closet-2');
    move(TENANT_A, 'clip-box', 'closet-2');
    expect(rows(TENANT_B)).toEqual(b);
    expect(await resolved(data, TENANT_B)).toEqual(BEFORE_MOVE);
    const closet2 = (await data(TENANT_B).locationTree()).find((n) => n.id === 'closet-2');
    expect(closet2?.children).toEqual([]);
  });
});

describe('a rename (id change) takes the tag with it', () => {
  it('before 0005, renaming a container dropped its tag; a leaf kept its tag', () => {
    // The behaviour this migration changes, shown on an 0004 database.
    const { db } = memoryDatabaseUpTo('0004_stock_passive_only.sql');
    populate(db, TENANT_A);
    db.prepare(
      "UPDATE location SET id = 'spare-box-2' WHERE tenant_id = ? AND id = 'spare-box'",
    ).run(TENANT_A);
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM tag WHERE tenant_id = ? AND tag_id = ?')
        .get(TENANT_A, T.spare),
    ).toEqual({ n: 0 });
  });

  it("re-points a tagged container's registry row to the new id; the tag ID stays the same", async () => {
    const { data, rows, registryTarget, rename } = setup();
    const before = rows(TENANT_A);
    rename(TENANT_A, 'spare-box', 'spare-box-2');
    expect(registryTarget(TENANT_A, T.spare)).toBe('spare-box-2');
    expect(rows(TENANT_A).tag).toEqual(
      before.tag.map((t) =>
        (t as { tag_id: string }).tag_id === T.spare ? { ...t, target_id: 'spare-box-2' } : t,
      ),
    );
    expect(await data(TENANT_A).tagView(T.spare)).toMatchObject({
      kind: 'container',
      location: { id: 'spare-box-2' },
    });
  });

  it('a leaf behaves the same: its column tag and registry row follow the new id', async () => {
    const { db, data, registryTarget, rename } = setup();
    rename(TENANT_A, 'bin', 'bin-2');
    expect(registryTarget(TENANT_A, T.bin)).toBe('bin-2');
    expect(
      db.prepare("SELECT tag_id FROM location WHERE tenant_id = ? AND id = 'bin-2'").get(TENANT_A),
    ).toEqual({ tag_id: T.bin });
    expect(await data(TENANT_A).tagView(T.bin)).toMatchObject({
      kind: 'location',
      location: { id: 'bin-2' },
    });
  });

  it('an untagged container gains no tag', () => {
    const { rows, rename } = setup();
    const before = rows(TENANT_A).tag;
    rename(TENANT_A, 'spare-room', 'spare-room-2');
    expect(rows(TENANT_A).tag).toEqual(before);
  });

  it('a leaf left out of step before rule 1 keeps its registry-only tag on rename too', () => {
    // A leaf from before rule 1, whose tag is a registry row only (built on an 0004 database).
    const { db: old } = memoryDatabaseUpTo('0004_stock_passive_only.sql');
    populate(old, TENANT_A);
    old
      .prepare(
        `UPDATE location SET type = 'clip_storage', leaf = 1, capacity = 5, capacity_mode = 'soft',
                tag_source = 'sticker' WHERE tenant_id = ? AND id = 'spare-box'`,
      )
      .run(TENANT_A);
    runMigrations(old);
    old
      .prepare("UPDATE location SET id = 'spare-box-2' WHERE tenant_id = ? AND id = 'spare-box'")
      .run(TENANT_A);
    expect(
      old
        .prepare('SELECT target_id FROM tag WHERE tenant_id = ? AND tag_id = ?')
        .get(TENANT_A, T.spare),
    ).toEqual({ target_id: 'spare-box-2' });
  });

  it('refuses renaming a place something refers to: children, clips, stock lines, events', () => {
    const { db, rows, rename } = setup();
    db.prepare(
      "INSERT INTO event (tenant_id, id, type, filament_id, to_location_id) VALUES (?, '00000000-0000-4000-8000-00000000e001', 'intake', ?, 'bin')",
    ).run(TENANT_A, FILAMENT);
    const before = rows(TENANT_A);
    for (const id of ['closet-1', 'cart', 'clip-box', 'shelf', 'bin']) {
      expect(() => rename(TENANT_A, id, `${id}-2`), id).toThrow(/FOREIGN KEY constraint failed/);
    }
    expect(rows(TENANT_A)).toEqual(before);
  });

  it('frees no tag ID: the renamed place still holds it, so it cannot be claimed elsewhere', async () => {
    const { data, rename } = setup();
    rename(TENANT_A, 'spare-box', 'spare-box-2');
    expect(await data(TENANT_A).claimTag(T.spare, 'spare-room', false)).toEqual({
      ok: false,
      refusal: 'tag_in_use',
    });
  });

  it("never touches another tenant's same-id rows or same tag IDs", async () => {
    const { data, rows, rename } = setup();
    const b = rows(TENANT_B);
    rename(TENANT_A, 'spare-box', 'spare-box-2');
    rename(TENANT_A, 'bin', 'bin-2');
    expect(rows(TENANT_B)).toEqual(b);
    expect(await resolved(data, TENANT_B)).toEqual(BEFORE_MOVE);
  });

  it("moving a row to another tenant still drops the old tenant's container tag (as in 0002)", () => {
    const { db, registryTarget } = setup();
    db.prepare("INSERT INTO tenant_settings (tenant_id) VALUES ('tenant-c')").run();
    db.prepare(
      "UPDATE location SET tenant_id = 'tenant-c', id = 'spare-box-2' WHERE tenant_id = ? AND id = 'spare-box'",
    ).run(TENANT_A);
    expect(registryTarget(TENANT_A, T.spare)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM tag WHERE tenant_id = 'tenant-c'").get()).toEqual({
      n: 0,
    });
  });
});

describe('a rename that also changes tag_id, and ids shared across record kinds', () => {
  const tagRows = (db: Db, tenant: string) =>
    db
      .prepare('SELECT tag_id, kind, target_id FROM tag WHERE tenant_id = ? ORDER BY tag_id')
      .all(tenant);
  const column = (db: Db, tenant: string, id: string) =>
    (
      db.prepare('SELECT tag_id FROM location WHERE tenant_id = ? AND id = ?').get(tenant, id) as
        { tag_id: string | null } | undefined
    )?.tag_id;

  it('a leaf renamed and untagged in one statement drops its tag (as in 0002) and leaves nothing out of step', () => {
    const { db } = setup();
    db.prepare(
      "UPDATE location SET id = 'bin-2', tag_id = NULL WHERE tenant_id = ? AND id = 'bin'",
    ).run(TENANT_A);
    expect(column(db, TENANT_A, 'bin-2')).toBeNull();
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM tag WHERE tenant_id = ? AND (tag_id = ? OR target_id = 'bin-2')",
        )
        .get(TENANT_A, T.bin),
    ).toEqual({ n: 0 });
  });

  it('an out-of-step leaf renamed and given a tag in one statement ends with only the new tag', () => {
    // Built on an 0004 database: 'spare-box' became a leaf and kept its registry-only tag.
    const { db } = memoryDatabaseUpTo('0004_stock_passive_only.sql');
    populate(db, TENANT_A);
    db.prepare(
      `UPDATE location SET type = 'clip_storage', leaf = 1, capacity = 5, capacity_mode = 'soft',
              tag_source = 'sticker' WHERE tenant_id = ? AND id = 'spare-box'`,
    ).run(TENANT_A);
    runMigrations(db);
    const fresh = 'F0110WTAG00A';
    db.prepare(
      "UPDATE location SET id = 'spare-box-2', tag_id = ? WHERE tenant_id = ? AND id = 'spare-box'",
    ).run(fresh, TENANT_A);
    expect(column(db, TENANT_A, 'spare-box-2')).toBe(fresh);
    const rows = tagRows(db, TENANT_A) as { tag_id: string; target_id: string }[];
    expect(rows.filter((r) => r.target_id === 'spare-box-2')).toEqual([
      { tag_id: fresh, kind: 'location', target_id: 'spare-box-2' },
    ]);
    expect(rows.some((r) => r.tag_id === T.spare)).toBe(false);
  });

  it("renaming a location whose id equals a clip's id leaves the clip's registry row alone", () => {
    // Ids may be UUIDs for both kinds, so a location and a clip can share one.
    const { db } = memoryDatabaseUpTo('0004_stock_passive_only.sql');
    populate(db, TENANT_A);
    db.prepare(
      "INSERT INTO location (tenant_id, id, name, type, leaf) VALUES (?, ?, 'Same id as a clip', 'container', 0)",
    ).run(TENANT_A, CLIP_A);
    const shared = 'F0110WTAG00B';
    db.prepare(
      "INSERT INTO tag (tenant_id, tag_id, kind, target_id) VALUES (?, ?, 'location', ?)",
    ).run(TENANT_A, shared, CLIP_A);
    runMigrations(db);
    db.prepare("UPDATE location SET id = 'renamed-place' WHERE tenant_id = ? AND id = ?").run(
      TENANT_A,
      CLIP_A,
    );
    const rows = tagRows(db, TENANT_A) as { tag_id: string; kind: string; target_id: string }[];
    expect(rows.find((r) => r.tag_id === T.clipA)).toEqual({
      tag_id: T.clipA,
      kind: 'clip',
      target_id: CLIP_A,
    });
    expect(rows.find((r) => r.tag_id === shared)).toEqual({
      tag_id: shared,
      kind: 'location',
      target_id: 'renamed-place',
    });
  });
});
