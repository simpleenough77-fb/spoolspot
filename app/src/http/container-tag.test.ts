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

type ContainerView = Extract<TagView, { kind: 'container' }>;

function asContainer(view: TagView | null): ContainerView {
  if (view?.kind !== 'container') throw new Error('expected a container view');
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
    expect(body.kind).toBe('container');
    expect(body.inside).toHaveLength(ACTIVE_SHELVES.length);
    expect(body.held_clip_used).toBe(false);
    db.prepare(
      "UPDATE location SET tag_id = 'KEAFTAG00001' WHERE tenant_id = ? AND id = 'loc1.shelf-1'",
    ).run(TENANT_A);
    const leaf = (await (await get('/api/v1/tags/KEAFTAG00001')).json()) as TagView;
    expect(Object.keys(leaf).sort()).toEqual(['kind', 'location']);
    expect(leaf.kind).toBe('location');
  });

  it('suggests by the intake order for an on_spool clip: same filament (other clips only), then most free', async () => {
    const { data, filament, clip, boxed, db } = await setup();
    const acme = filament(TENANT_A, 'Acme');
    const other = filament(TENANT_A, 'Other');
    const held = clip(TENANT_A, acme, 'loc1.shelf-1');
    const scoped = data(TENANT_A);

    // No held clip: most free first (loc1.shelf-2 has 16 free; loc1.shelf-1 has 15 with the clip).
    let view = asContainer(await scoped.tagView(ACTIVE_TAG));
    expect(view.suggestion).toMatchObject({ location_id: 'loc1.shelf-2', reason: 'most_free' });

    // Boxed stock is not "the same filament here" (owner decision 2026-11-12: only clipped spools
    // count). Boxed stock lives on passive storage only (SPOOL-200): the ranking stays most free.
    boxed(TENANT_A, acme, 'closet-storage.shelf-1', 2);
    view = asContainer(await scoped.tagView(ACTIVE_TAG, held));
    expect(view.held_clip_used).toBe(true);
    expect(view.suggestion).toMatchObject({ location_id: 'loc1.shelf-2', reason: 'most_free' });

    // Another clip of the same filament on a smaller shelf wins over more room elsewhere.
    clip(TENANT_A, acme, 'loc2.shelf-4');
    view = asContainer(await scoped.tagView(ACTIVE_TAG, held));
    expect(view.suggestion).toMatchObject({ location_id: 'loc2.shelf-4', reason: 'same_filament' });

    // Once that shelf is full (hard limit) it is never suggested. A manufacturer preference on an
    // active shelf is ignored (owner decision 2026-11-11: it applies to clip storage only).
    // Filled with clips of another filament: boxed stock cannot sit on an active shelf (SPOOL-200).
    for (let i = 0; i < 9; i += 1) clip(TENANT_A, other, 'loc2.shelf-4');
    db.prepare(
      "UPDATE location SET prefers_manufacturer = 'Acme' WHERE tenant_id = ? AND id = 'loc3.shelf-3'",
    ).run(TENANT_A);
    view = asContainer(await scoped.tagView(ACTIVE_TAG, held));
    expect(view.suggestion).toMatchObject({ location_id: 'loc1.shelf-2', reason: 'most_free' });

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
    const { data, filament, clip, tagContainer, db } = await setup();
    const f = filament(TENANT_A, 'Acme');
    const scoped = data(TENANT_A);
    for (const shelf of ACTIVE_SHELVES) {
      const capacity = (
        db
          .prepare('SELECT capacity FROM location WHERE tenant_id = ? AND id = ?')
          .get(TENANT_A, shelf) as { capacity: number }
      ).capacity;
      // Clips, not boxed stock: boxed stock cannot sit on an active shelf (SPOOL-200).
      for (let i = 0; i < capacity; i += 1) clip(TENANT_A, f, shelf);
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

  it('suggests nothing for a held clip that sits in a slot (a move out of a slot is refused)', async () => {
    const { data, filament, clip } = await setup();
    const f = filament(TENANT_A, 'Acme');
    const loaded = clip(TENANT_A, f, 'dreammaker.ams-a.slot-1');
    const scoped = data(TENANT_A);
    const view = asContainer(await scoped.tagView(ACTIVE_TAG, loaded));
    expect(view.held_clip_used).toBe(true);
    expect(view.suggestion).toBeNull();
    expect(view.inside.map((l) => l.id)).toEqual(ACTIVE_SHELVES);
    // The advice would be unfollowable: the move API refuses a move out of a slot.
    expect(await scoped.moveClip(loaded, 'loc1.shelf-2', false)).toMatchObject({
      ok: false,
      refusal: 'slot_not_supported',
    });
    // Nothing held, the same container still suggests by most free.
    expect(asContainer(await scoped.tagView(ACTIVE_TAG)).suggestion).toMatchObject({
      location_id: 'loc1.shelf-1',
      reason: 'most_free',
    });
  });

  describe('candidates by the held clip’s state (owner decision 2026-11-11)', () => {
    const HOME_TAG = 'C0NTA1NER0HM';
    const CLIPS_TAG = 'C0NTA1NER0CS';
    async function stateSetup() {
      const s = await setup();
      s.tagContainer(TENANT_A, HOME_TAG, 'home');
      s.tagContainer(TENANT_A, CLIPS_TAG, 'clips');
      const set = (id: string, capacity: number, prefers: string | null = null): void => {
        s.db
          .prepare(
            'UPDATE location SET capacity = ?, prefers_manufacturer = ? WHERE tenant_id = ? AND id = ?',
          )
          .run(capacity, prefers, TENANT_A, id);
      };
      return { ...s, set, scoped: s.data(TENANT_A), acme: s.filament(TENANT_A, 'Acme') };
    }

    it('never sends an on_spool clip to a clip bin that prefers its manufacturer (S1)', async () => {
      const { scoped, set, clip, acme } = await stateSetup();
      set('clips.bin-1', 50, 'Acme');
      const held = clip(TENANT_A, acme, 'loc1.shelf-1');
      const view = asContainer(await scoped.tagView(HOME_TAG, held));
      expect(view.suggestion).toMatchObject({
        location_id: 'loc1.shelf-2',
        type: 'active_storage',
        reason: 'most_free',
      });
    });

    it('never sends an on_spool clip to a passive shelf boxing the same filament (S2)', async () => {
      const { scoped, set, clip, boxed, acme } = await stateSetup();
      set('closet-storage.shelf-1', 50);
      boxed(TENANT_A, acme, 'closet-storage.shelf-1', 3);
      const held = clip(TENANT_A, acme, 'loc1.shelf-1');
      let view = asContainer(await scoped.tagView(HOME_TAG, held));
      expect(view.suggestion).toMatchObject({ location_id: 'loc1.shelf-2', reason: 'most_free' });
      // Another clip of the filament on an active shelf still ranks that shelf first.
      clip(TENANT_A, acme, 'loc3.shelf-2');
      view = asContainer(await scoped.tagView(HOME_TAG, held));
      expect(view.suggestion).toMatchObject({
        location_id: 'loc3.shelf-2',
        type: 'active_storage',
        reason: 'same_filament',
      });
    });

    for (const state of ['free', 'spool_empty'] as const) {
      it(`sends a ${state} clip only to clip storage, where its manufacturer preference ranks`, async () => {
        const { scoped, set, clip, boxed, acme, db } = await stateSetup();
        db.prepare(
          "INSERT INTO location (tenant_id, id, name, type, parent, leaf, capacity, capacity_mode, prefers_manufacturer, tag_source) VALUES (?, 'clips.bin-2', 'Clip bin 2', 'clip_storage', 'clips', 1, 5, 'soft', 'Acme', 'sticker')",
        ).run(TENANT_A);
        set('clips.bin-1', 20);
        set('closet-storage.shelf-1', 50);
        // The same filament on an active and a passive shelf: neither is a candidate for this clip.
        clip(TENANT_A, acme, 'loc2.shelf-2');
        boxed(TENANT_A, acme, 'closet-storage.shelf-1', 3);
        const held = clip(TENANT_A, acme, 'loc2.shelf-1', state);
        let view = asContainer(await scoped.tagView(HOME_TAG, held));
        expect(view.suggestion).toMatchObject({
          location_id: 'clips.bin-2',
          type: 'clip_storage',
          reason: 'manufacturer_preference',
        });
        db.prepare(
          "UPDATE location SET prefers_manufacturer = NULL WHERE tenant_id = ? AND id = 'clips.bin-2'",
        ).run(TENANT_A);
        view = asContainer(await scoped.tagView(HOME_TAG, held));
        expect(view.suggestion).toMatchObject({ location_id: 'clips.bin-1', reason: 'most_free' });
        // Another clip of the same filament in clip storage makes that bin "the same filament here".
        clip(TENANT_A, acme, 'clips.bin-2', 'free');
        view = asContainer(await scoped.tagView(HOME_TAG, held));
        expect(view.suggestion).toMatchObject({
          location_id: 'clips.bin-2',
          reason: 'same_filament',
        });
      });
    }

    it('suggests nothing when the container holds no leaf the clip’s state allows', async () => {
      const { scoped, set, clip, acme } = await stateSetup();
      set('clips.bin-1', 20);
      const onSpool = clip(TENANT_A, acme, 'loc1.shelf-1');
      const free = clip(TENANT_A, acme, null, 'free');
      const clipsOnly = asContainer(await scoped.tagView(CLIPS_TAG, onSpool));
      expect(clipsOnly.held_clip_used).toBe(true);
      expect(clipsOnly.suggestion).toBeNull();
      const shelvesOnly = asContainer(await scoped.tagView(ACTIVE_TAG, free));
      expect(shelvesOnly.held_clip_used).toBe(true);
      expect(shelvesOnly.suggestion).toBeNull();
      // With nothing held the most-free rule is unchanged.
      expect(asContainer(await scoped.tagView(CLIPS_TAG)).suggestion).toMatchObject({
        location_id: 'clips.bin-1',
      });
    });
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
    boxed(TENANT_A, shared, 'closet-storage.shelf-1', 2);
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
