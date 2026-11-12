// SPDX-License-Identifier: AGPL-3.0-or-later
// Container tags (SPOOL-191): a tag registered to a container resolves, in its own tenant only, to the
// leaves below it with their room and one advisory suggestion for the held clip (intake order).
import { describe, expect, it } from 'vitest';
import { createDevTokenProvider } from '../auth/dev-token.ts';
import { Scope, type Principal } from '../auth/principal.ts';
import { createScopedData, type TagView } from '../data/scoped.ts';
import { importSeed } from '../seed/import.ts';
import {
  memoryDatabase,
  readJson,
  readSeed,
  SEED_SCHEMA_PATH,
  TENANT_A,
  TENANT_B,
  TEST_TOKEN,
  uuid,
} from '../testing.ts';
import { createApp } from './app.ts';

const HOSTS = ['localhost'];
const bearer = { authorization: `Bearer ${TEST_TOKEN}` };
/** Valid Crockford base32 tag IDs. */
const ACTIVE_TAG = 'C0NTA1NER0AC';
const AMS_TAG = 'C0NTA1NER0AM';
const B_TAG = 'C0NTA1NER0BB';
const ACTIVE_SHELVES = [
  'loc1.shelf-1',
  'loc1.shelf-2',
  'loc2.shelf-1',
  'loc2.shelf-2',
  'loc2.shelf-3',
  'loc2.shelf-4',
  'loc3.shelf-1',
  'loc3.shelf-2',
  'loc3.shelf-3',
];

function principal(tenantId: string): Principal {
  return {
    subject: 'test',
    tenantId,
    scopes: new Set([Scope.LocationsRead, Scope.InventoryWrite]),
  };
}

let tagCounter = 0;
function clipTag(): string {
  tagCounter += 1;
  return `K${String(tagCounter).padStart(11, '0')}`;
}

async function setup() {
  const { sql, db } = memoryDatabase();
  await importSeed(sql, TENANT_A, readSeed(), readJson(SEED_SCHEMA_PATH));
  db.prepare('INSERT INTO tenant_settings (tenant_id) VALUES (?)').run(TENANT_B);
  await importSeed(sql, TENANT_B, readSeed(), readJson(SEED_SCHEMA_PATH));
  const filament = (tenant: string, manufacturer: string, id = uuid()): string => {
    db.prepare(
      "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, ?, 'PLA', ?, 'disposable')",
    ).run(tenant, id, manufacturer, id);
    return id;
  };
  const clip = (
    tenant: string,
    filamentId: string,
    location: string | null,
    state: 'on_spool' | 'spool_empty' | 'free' = 'on_spool',
  ): string => {
    const id = uuid();
    db.prepare(
      'INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(tenant, id, clipTag(), filamentId, location, state);
    return id;
  };
  const boxed = (tenant: string, filamentId: string, location: string, count: number): void => {
    db.prepare(
      "INSERT INTO stock_line (tenant_id, id, filament_id, location_id, pack, count) VALUES (?, ?, ?, ?, 'spool', ?)",
    ).run(tenant, uuid(), filamentId, location, count);
  };
  /** Decision 2: a container tag is a row in the tag registry only (kind location, target the container). */
  const tagContainer = (tenant: string, tag: string, container: string): void => {
    db.prepare(
      "INSERT INTO tag (tenant_id, tag_id, kind, target_id) VALUES (?, ?, 'location', ?)",
    ).run(tenant, tag, container);
  };
  tagContainer(TENANT_A, ACTIVE_TAG, 'active');
  tagContainer(TENANT_A, AMS_TAG, 'dreammaker.ams-a');
  const appFor = (tenant: string) =>
    createApp({
      auth: createDevTokenProvider({ token: TEST_TOKEN, tenantId: tenant }),
      data: (p) => createScopedData(sql, p),
      allowedHosts: HOSTS,
    });
  const appA = appFor(TENANT_A);
  const appB = appFor(TENANT_B);
  const get = (path: string, app = appA) =>
    app.request(`http://localhost${path}`, { headers: { host: 'localhost', ...bearer } });
  const data = (tenant: string) => createScopedData(sql, principal(tenant));
  return { db, sql, get, appB, data, filament, clip, boxed, tagContainer };
}

type ContainerView = Extract<TagView, { inside: unknown }>;

function asContainer(view: TagView | null): ContainerView {
  if (view === null || !('inside' in view)) throw new Error('expected a container view');
  return view;
}

describe('container tags (SPOOL-191)', () => {
  it('resolves a container tag to every leaf below it, with used, capacity and free', async () => {
    const { data, filament, clip } = await setup();
    const f = filament(TENANT_A, 'Acme');
    clip(TENANT_A, f, 'loc2.shelf-1');
    const view = asContainer(await data(TENANT_A).tagView(ACTIVE_TAG));
    expect(view.location).toMatchObject({ id: 'active', leaf: false, capacity: 107, used: 1 });
    expect(view.inside.map((l) => l.id)).toEqual(ACTIVE_SHELVES);
    expect(view.inside.every((l) => l.leaf)).toBe(true);
    expect(view.inside.find((l) => l.id === 'loc2.shelf-1')).toEqual({
      id: 'loc2.shelf-1',
      name: expect.any(String) as string,
      type: 'active_storage',
      leaf: true,
      capacity_mode: 'hard',
      capacity: 10,
      used: 1,
      free: 9,
    });
  });

  it('resolves through the API in either case, and a leaf tag keeps its old shape', async () => {
    const { get, db } = await setup();
    const res = await get(`/api/v1/tags/${ACTIVE_TAG.toLowerCase()}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ContainerView;
    expect(body.kind).toBe('location');
    expect(body.inside).toHaveLength(ACTIVE_SHELVES.length);
    expect(body.held_clip_used).toBe(false);
    db.prepare(
      "UPDATE location SET tag_id = 'KEAFTAG00001' WHERE tenant_id = ? AND id = 'loc1.shelf-1'",
    ).run(TENANT_A);
    const leaf = (await (await get('/api/v1/tags/KEAFTAG00001')).json()) as object;
    expect(Object.keys(leaf).sort()).toEqual(['kind', 'location']);
  });

  it('suggests by the intake order: same filament, then manufacturer preference, then most free', async () => {
    const { data, filament, clip, boxed, db } = await setup();
    const acme = filament(TENANT_A, 'Acme');
    const other = filament(TENANT_A, 'Other');
    const held = clip(TENANT_A, acme, 'loc1.shelf-1');
    const scoped = data(TENANT_A);

    // No held clip: most free first (loc1.shelf-2 has 16 free; loc1.shelf-1 has 15 with the clip).
    let view = asContainer(await scoped.tagView(ACTIVE_TAG));
    expect(view.suggestion).toMatchObject({ location_id: 'loc1.shelf-2', reason: 'most_free' });

    // A stock line whose count is 0 is not "the same filament here", even on a roomier shelf.
    boxed(TENANT_A, acme, 'loc3.shelf-1', 0);
    view = asContainer(await scoped.tagView(ACTIVE_TAG, held));
    expect(view.held_clip_used).toBe(true);
    expect(view.suggestion).toMatchObject({ location_id: 'loc1.shelf-2', reason: 'most_free' });

    // The same filament boxed on a small shelf wins over more room elsewhere.
    boxed(TENANT_A, acme, 'loc2.shelf-4', 2);
    view = asContainer(await scoped.tagView(ACTIVE_TAG, held));
    expect(view.held_clip_used).toBe(true);
    expect(view.suggestion).toMatchObject({ location_id: 'loc2.shelf-4', reason: 'same_filament' });

    // Once that shelf is full (hard limit) it is never suggested; manufacturer preference is next.
    boxed(TENANT_A, other, 'loc2.shelf-4', 8);
    db.prepare(
      "UPDATE location SET prefers_manufacturer = 'Acme' WHERE tenant_id = ? AND id = 'loc3.shelf-3'",
    ).run(TENANT_A);
    view = asContainer(await scoped.tagView(ACTIVE_TAG, held));
    expect(view.suggestion).toMatchObject({
      location_id: 'loc3.shelf-3',
      reason: 'manufacturer_preference',
    });

    // The held clip's own place is never offered, even when it has the most room.
    db.prepare(
      "UPDATE location SET prefers_manufacturer = NULL WHERE tenant_id = ? AND id = 'loc3.shelf-3'",
    ).run(TENANT_A);
    db.prepare("UPDATE location SET capacity = 20 WHERE tenant_id = ? AND id = 'loc1.shelf-1'").run(
      TENANT_A,
    );
    view = asContainer(await scoped.tagView(ACTIVE_TAG, held));
    expect(view.suggestion).toMatchObject({ location_id: 'loc1.shelf-2', reason: 'most_free' });
  });

  it('never suggests past a hard limit, a slot or a leaf with no capacity', async () => {
    const { data, filament, boxed, tagContainer, db } = await setup();
    const f = filament(TENANT_A, 'Acme');
    const scoped = data(TENANT_A);
    for (const shelf of ACTIVE_SHELVES) {
      const capacity = (
        db
          .prepare('SELECT capacity FROM location WHERE tenant_id = ? AND id = ?')
          .get(TENANT_A, shelf) as { capacity: number }
      ).capacity;
      boxed(TENANT_A, f, shelf, capacity);
    }
    // Every active shelf is at its hard limit: nothing to suggest, though every leaf is listed.
    const full = asContainer(await scoped.tagView(ACTIVE_TAG));
    expect(full.suggestion).toBeNull();
    expect(full.inside.every((l) => l.free === 0)).toBe(true);
    // A container of free slots: slots are listed but never suggested (the load workflow fills them).
    const ams = asContainer(await scoped.tagView(AMS_TAG));
    expect(ams.inside.map((l) => l.type)).toEqual(Array(4).fill('active_use'));
    expect(ams.suggestion).toBeNull();
    // Passive shelves have no capacity in the seed: listed, never suggested.
    tagContainer(TENANT_A, 'C0NTA1NER0PS', 'closet-storage');
    const passive = asContainer(await scoped.tagView('C0NTA1NER0PS'));
    expect(passive.inside).toHaveLength(5);
    expect(passive.suggestion).toBeNull();
  });

  it('is advisory: resolving moves nothing, and a different leaf can still be chosen', async () => {
    const { data, filament, clip } = await setup();
    const f = filament(TENANT_A, 'Acme');
    const held = clip(TENANT_A, f, 'loc1.shelf-1');
    const scoped = data(TENANT_A);
    const view = asContainer(await scoped.tagView(ACTIVE_TAG, held));
    expect(view.suggestion?.location_id).toBe('loc1.shelf-2');
    expect((await scoped.clipsAt('loc1.shelf-1'))?.map((c) => c.id)).toEqual([held]);
    const moved = await scoped.moveClip(held, 'loc3.shelf-1', false);
    expect(moved).toMatchObject({ ok: true, moved: true });
  });

  it('gives the same 404 for an unknown, a malformed and another tenant’s container tag', async () => {
    const { get, appB, tagContainer } = await setup();
    // A tag registered only in tenant B (and A's tag asked for in B) is unknown to the asker.
    tagContainer(TENANT_B, B_TAG, 'passive');
    const bodies: string[] = [];
    for (const [tag, app] of [
      ['ZZZZZZZZZZZZ', undefined],
      ['C0NTA1NER0A', undefined],
      ['C0NTA1NER0A!', undefined],
      [B_TAG, undefined],
      [ACTIVE_TAG, appB],
    ] as const) {
      const res = await get(`/api/v1/tags/${encodeURIComponent(tag)}`, app);
      expect(res.status, tag).toBe(404);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it('resolves the same tag ID registered in two tenants to each tenant’s own container', async () => {
    const { get, appB, tagContainer } = await setup();
    // Tenant B registers A's tag ID on a different container of its own.
    tagContainer(TENANT_B, ACTIVE_TAG, 'passive');
    const a = (await (await get(`/api/v1/tags/${ACTIVE_TAG}`)).json()) as ContainerView;
    const b = (await (await get(`/api/v1/tags/${ACTIVE_TAG}`, appB)).json()) as ContainerView;
    expect(a.location.id).toBe('active');
    expect(a.inside.map((l) => l.id)).toEqual(ACTIVE_SHELVES);
    expect(b.location.id).toBe('passive');
    expect(b.inside.every((l) => l.type === 'passive_storage')).toBe(true);
  });

  it('ranks a held clip with its own tenant’s data only (stock, other clips, manufacturer preference)', async () => {
    const { data, filament, clip, boxed, tagContainer, db } = await setup();
    // The same filament id and manufacturer exist in both tenants; every leaf slug exists in both.
    const shared = filament(TENANT_B, 'Acme');
    filament(TENANT_A, 'Acme', shared);
    const binB = filament(TENANT_B, 'Acme');
    const heldShelf = clip(TENANT_B, shared, 'loc1.shelf-1');
    const heldFree = clip(TENANT_B, binB, null, 'free');
    tagContainer(TENANT_B, B_TAG, 'active');
    tagContainer(TENANT_B, 'C0NTA1NER0BC', 'clips');
    for (const tenant of [TENANT_A, TENANT_B]) {
      db.prepare(
        "UPDATE location SET capacity = 20 WHERE tenant_id = ? AND id = 'clips.bin-1'",
      ).run(tenant);
    }
    const scopedB = data(TENANT_B);
    const views = async () => [
      asContainer(await scopedB.tagView(B_TAG, heldShelf)),
      asContainer(await scopedB.tagView('C0NTA1NER0BC', heldFree)),
    ];
    const before = await views();
    expect(before[0]?.suggestion).toMatchObject({
      location_id: 'loc1.shelf-2',
      reason: 'most_free',
    });
    expect(before[1]?.suggestion).toMatchObject({
      location_id: 'clips.bin-1',
      reason: 'most_free',
    });
    // Tenant A: the same filament boxed and clipped, and a matching manufacturer preference.
    boxed(TENANT_A, shared, 'loc2.shelf-4', 2);
    clip(TENANT_A, shared, 'loc2.shelf-3');
    db.prepare(
      "UPDATE location SET prefers_manufacturer = 'Acme' WHERE tenant_id = ? AND id = 'clips.bin-1'",
    ).run(TENANT_A);
    const after = await views();
    expect(after).toEqual(before);
    expect(after.map((v) => v.suggestion?.reason)).toEqual(['most_free', 'most_free']);
  });

  it('suggests only inside the tapped container, even when a roomier leaf is elsewhere', async () => {
    const { data, tagContainer, db } = await setup();
    tagContainer(TENANT_A, 'C0NTA1NER001', 'loc1');
    // loc3.shelf-1 (outside loc1) becomes the roomiest active shelf in the tree.
    db.prepare("UPDATE location SET capacity = 40 WHERE tenant_id = ? AND id = 'loc3.shelf-1'").run(
      TENANT_A,
    );
    const view = asContainer(await data(TENANT_A).tagView('C0NTA1NER001'));
    expect(view.inside.map((l) => l.id)).toEqual(['loc1.shelf-1', 'loc1.shelf-2']);
    expect(view.suggestion?.location_id).toBe('loc1.shelf-1');
    expect(view.inside.map((l) => l.id)).toContain(view.suggestion?.location_id);
  });

  it('never lets another tenant resolve or see the first tenant’s container tag, leaves or clips', async () => {
    const { data, filament, clip, tagContainer } = await setup();
    const fa = filament(TENANT_A, 'Acme');
    const heldA = clip(TENANT_A, fa, 'loc2.shelf-1');
    clip(TENANT_A, fa, 'loc2.shelf-2');
    expect(await data(TENANT_B).tagView(ACTIVE_TAG)).toBeNull();
    expect(await data(TENANT_B).resolveTag(ACTIVE_TAG)).toBeNull();
    // B's own container tag shows B's leaves only, with none of A's clips counted.
    tagContainer(TENANT_B, B_TAG, 'active');
    const b = asContainer(await data(TENANT_B).tagView(B_TAG));
    expect(b.location.used).toBe(0);
    expect(b.inside.every((l) => l.used === 0)).toBe(true);
    // A's clip id held in B's tenant is ignored, exactly as if no clip was held.
    const withForeign = asContainer(await data(TENANT_B).tagView(B_TAG, heldA));
    expect(withForeign.held_clip_used).toBe(false);
    expect(withForeign).toEqual(b);
    // An unknown clip id in A's own tenant is ignored the same way.
    const unknown = asContainer(await data(TENANT_A).tagView(ACTIVE_TAG, uuid()));
    expect(unknown.held_clip_used).toBe(false);
  });

  it('refuses a malformed or repeated held id before looking at the tag', async () => {
    const { get } = await setup();
    for (const tag of [ACTIVE_TAG, 'ZZZZZZZZZZZZ']) {
      for (const q of ['held=nope', 'held=', `held=${uuid()}&held=${uuid()}`, "held=' OR 1=1"]) {
        const res = await get(`/api/v1/tags/${tag}?${q.replace(/ /g, '%20')}`);
        expect(res.status, `${tag} ${q}`).toBe(400);
        expect(await res.json()).toEqual({ error: 'invalid_request' });
      }
    }
    expect((await get(`/api/v1/tags/${ACTIVE_TAG}?held=${uuid()}`)).status).toBe(200);
  });

  it('needs the read scope', async () => {
    const { sql } = await setup();
    const none: Principal = { subject: 'x', tenantId: TENANT_A, scopes: new Set() };
    await expect(createScopedData(sql, none).tagView(ACTIVE_TAG)).rejects.toThrow();
  });
});
