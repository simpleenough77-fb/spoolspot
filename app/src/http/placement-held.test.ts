// SPDX-License-Identifier: AGPL-3.0-or-later
// SPOOL-210: GET /api/v1/placement-suggestions?within=<place>&held=<clip> answers with the same
// suggestion a container tag gives for that container and clip, so a container chosen from the tap
// page's list (no NFC) gets what tapping its tag gets. Without `held` every answer is byte-identical to
// main before this change.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDevTokenProvider } from '../auth/dev-token.ts';
import type { AuthProvider } from '../auth/principal.ts';
import { createScopedData } from '../data/scoped.ts';
import type { Sql, SqlParam } from '../db/sql.ts';
import { runMigrations } from '../db/migrate.ts';
import { importSeed } from '../seed/import.ts';
import {
  memoryDatabase,
  memoryDatabaseUpTo,
  readJson,
  readSeed,
  SEED_SCHEMA_PATH,
  TENANT_A,
  TENANT_B,
  TEST_TOKEN,
} from '../testing.ts';
import { createApp } from './app.ts';

const bearer = { authorization: `Bearer ${TEST_TOKEN}` };
const F_ACME = '00000000-0000-4000-8000-0000000a0001';
const F_OTHER = '00000000-0000-4000-8000-0000000a0002';

/** Status, every header and the body, as one string: what "byte-identical" compares. */
async function full(res: Response): Promise<string> {
  return `${String(res.status)} ${JSON.stringify([...res.headers])} ${await res.text()}`;
}
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Every statement the data layer runs, with its parameters, in order. */
function recording(sql: Sql): { sql: Sql; log: { query: string; params: SqlParam[] }[] } {
  const log: { query: string; params: SqlParam[] }[] = [];
  return {
    log,
    sql: {
      all: (query, params = []) => {
        log.push({ query, params: [...params] });
        return sql.all(query, params);
      },
      batch: (statements) => {
        for (const s of statements) log.push({ query: s.query, params: [...(s.params ?? [])] });
        return sql.batch(statements);
      },
    },
  };
}

/** The fixed data the recorded main answers were taken from. Every id is fixed, so answers are stable. */
async function fixture() {
  const { sql, db } = memoryDatabase();
  await importSeed(sql, TENANT_A, readSeed(), readJson(SEED_SCHEMA_PATH));
  db.prepare('INSERT INTO tenant_settings (tenant_id) VALUES (?)').run(TENANT_B);
  await importSeed(sql, TENANT_B, readSeed(), readJson(SEED_SCHEMA_PATH));
  for (const [id, maker] of [
    [F_ACME, 'Acme'],
    [F_OTHER, 'Other'],
  ] as const) {
    db.prepare(
      "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, ?, 'PLA', 'Red', 'disposable')",
    ).run(TENANT_A, id, maker);
  }
  const clips: [string, string, string | null, string][] = [
    ['00000000-0000-4000-8000-0000000c0001', F_ACME, 'loc1.shelf-1', 'on_spool'],
    ['00000000-0000-4000-8000-0000000c0002', F_ACME, 'loc2.shelf-4', 'on_spool'],
    ['00000000-0000-4000-8000-0000000c0003', F_OTHER, 'loc2.shelf-4', 'on_spool'],
    ['00000000-0000-4000-8000-0000000c0004', F_OTHER, 'dreammaker.ams-a.slot-1', 'on_spool'],
    ['00000000-0000-4000-8000-0000000c0005', F_ACME, 'clips.bin-1', 'free'],
  ];
  clips.forEach(([id, f, at, state], i) => {
    db.prepare(
      'INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(TENANT_A, id, `KHD${String(i).padStart(9, '0')}`, f, at, state);
  });
  db.prepare(
    "UPDATE location SET capacity = 20, prefers_manufacturer = 'Acme' WHERE tenant_id = ? AND id = 'clips.bin-1'",
  ).run(TENANT_A);
  db.prepare(
    "UPDATE location SET capacity = 6 WHERE tenant_id = ? AND id = 'closet-storage.shelf-1'",
  ).run(TENANT_A);
  db.prepare(
    "INSERT INTO stock_line (tenant_id, id, filament_id, location_id, pack, count) VALUES (?, '00000000-0000-4000-8000-0000000d0001', ?, 'closet-storage.shelf-1', 'spool', 2)",
  ).run(TENANT_A, F_ACME);
  db.prepare(
    "INSERT INTO location (tenant_id, id, name, type, parent, leaf, tag_source) VALUES (?, 'b-room', 'B room', 'container', 'home', 0, NULL)",
  ).run(TENANT_B);
  const app = createApp({
    auth: createDevTokenProvider({ token: TEST_TOKEN, tenantId: TENANT_A }),
    data: (p) => createScopedData(sql, p),
    allowedHosts: ['localhost'],
  });
  return (path: string) =>
    app.request(`http://localhost${path}`, { headers: { host: 'localhost', ...bearer } });
}

/**
 * Recorded on main at e33bce2 (before SPOOL-210) from fixture() above: sha256 of `full()` for each
 * query, none of which sends `held`. Changing this table means an existing caller sees a change.
 */
const MAIN: Record<string, string> = {
  'count=1': 'dad7553be098862822409bfcaf6d95c00109a4c803672437148984885357ebd7',
  'count=3': 'dad7553be098862822409bfcaf6d95c00109a4c803672437148984885357ebd7',
  'count=1000': '943055169b0e0cb9fac40ed0299decfbc6f64dce74b81ae92edf743ba9a194b0',
  'count=1&type=active_storage': '38c01deb8781e096f9be6240e8a47187b809ae0bbf3e2985ccd1c81909da2f2e',
  'count=1&type=active_use': 'cc020160833661aa6435c47e59dd6b60bcdd26a868cfad2bf803738a72eb26c2',
  'count=1&type=clip_storage': 'af104ddfdd912afc43e97e0929e4b73d69e2e52c5e80dd0ff3a7f86996424739',
  'count=1&type=passive_storage':
    '8095ef7fc166e0402ee0b3a199a8f0dc4e1cc65f1884f990f218746c8eda141f',
  'count=1&within=loc1': 'e8fcc1655ad601f3a0a59e563b8226c541b88f6c618af0bc3e3f80dd269c72f8',
  'count=1&within=loc2': '6189bacac93b2dee19279b7998c12ddaee522b8b317611d112b064fa97f3bf62',
  'count=1&within=active': '38c01deb8781e096f9be6240e8a47187b809ae0bbf3e2985ccd1c81909da2f2e',
  'count=2&within=home': 'dad7553be098862822409bfcaf6d95c00109a4c803672437148984885357ebd7',
  'count=1&within=home&type=active_use':
    'cc020160833661aa6435c47e59dd6b60bcdd26a868cfad2bf803738a72eb26c2',
  'count=1&within=dreammaker.ams-a':
    'a14b56defef07ef49a49534ac8324da41c1008e5046310c7cab6421323186098',
  'count=1&within=loc1.shelf-1': '6b1538ee24bb4146e2c33a5a58aedc36dbc866219a7f1968b9857f7b18b562c7',
  'count=1&within=loc2.shelf-4': 'a9eeadb2deae74bfa3114f720c1b51ecb580d6ea6c6eb35704fd0c52f8063906',
  'count=1&within=clips': 'af104ddfdd912afc43e97e0929e4b73d69e2e52c5e80dd0ff3a7f86996424739',
  'count=1&within=closet-storage':
    '8095ef7fc166e0402ee0b3a199a8f0dc4e1cc65f1884f990f218746c8eda141f',
  'count=1&within=active&type=active_storage':
    '38c01deb8781e096f9be6240e8a47187b809ae0bbf3e2985ccd1c81909da2f2e',
  'count=1&within=nope': 'b96d6d7205201b32117dd228b86b2e387fb642624cc79d127019bab822bd1b28',
  'count=1&within=b-room': 'b96d6d7205201b32117dd228b86b2e387fb642624cc79d127019bab822bd1b28',
  'count=0': '24d3834edb7ee989e31426d3006df1b7b74f9dfccb9f90b33244d41b792081e6',
  'count=1&count=2': '24d3834edb7ee989e31426d3006df1b7b74f9dfccb9f90b33244d41b792081e6',
  'type=active_storage': '24d3834edb7ee989e31426d3006df1b7b74f9dfccb9f90b33244d41b792081e6',
  'count=1&type=nope': '24d3834edb7ee989e31426d3006df1b7b74f9dfccb9f90b33244d41b792081e6',
  'count=1&within=': '24d3834edb7ee989e31426d3006df1b7b74f9dfccb9f90b33244d41b792081e6',
  'count=1&within=a&within=b': '24d3834edb7ee989e31426d3006df1b7b74f9dfccb9f90b33244d41b792081e6',
  'count=1&within=%2e%2e': '24d3834edb7ee989e31426d3006df1b7b74f9dfccb9f90b33244d41b792081e6',
};

describe('placement suggestions without held (unchanged from main)', () => {
  it('answers every recorded query byte-identically to main', async () => {
    const get = await fixture();
    const now: Record<string, string> = {};
    for (const query of Object.keys(MAIN)) {
      now[query] = sha(await full(await get(`/api/v1/placement-suggestions?${query}`)));
    }
    expect(now).toEqual(MAIN);
  });
});

// ---------------------------------------------------------------------------------------------------
// With `held`: the list path gives what the tag path gives.

interface Suggestion {
  location_id: string;
  name: string;
  type: string;
  capacity_mode: 'hard' | 'soft';
  free: number;
  fits_all: boolean;
  reason: string;
}
interface Place {
  id: string;
  leaf: boolean;
  children?: Place[];
}
interface ContainerView {
  kind: 'container';
  suggestion: Suggestion | null;
  held_clip_used: boolean;
}
interface TapView {
  findNode(nodes: Place[], id: string): Place | null;
  suggestionsPath(placeId: string, held: { id: string } | null): string;
  browsedView(node: Place, answer: unknown, held: { id: string } | null): ContainerView | null;
}
// The page's own module (plain browser JavaScript, no DOM at load time), so the list path is tested
// exactly as tap.js takes it: the request it builds and the view it makes of the answer.
const tapView = (await import(new URL('../../public/tapview.js', import.meta.url).href)) as TapView;

const ACTIVE_TAG = 'HC0NTA1NER0A';
const AMS_TAG = 'HC0NTA1NER0M';
const HOME_TAG = 'HC0NTA1NER0H';
const CLIPS_TAG = 'HC0NTA1NER0C';
const LOC1_TAG = 'HC0NTA1NER01';
const PASSIVE_TAG = 'HC0NTA1NER0P';
const B_TAG = 'HC0NTA1NER0B';
const CONTAINERS: Record<string, string> = {
  [ACTIVE_TAG]: 'active',
  [AMS_TAG]: 'dreammaker.ams-a',
  [HOME_TAG]: 'home',
  [CLIPS_TAG]: 'clips',
  [LOC1_TAG]: 'loc1',
  [PASSIVE_TAG]: 'closet-storage',
};

let n = 0;
let fid = 0;
async function setup(options: { before0004?: boolean } = {}) {
  const { sql: raw, db } = options.before0004
    ? memoryDatabaseUpTo('0003_event_delete_grant.sql')
    : memoryDatabase();
  await importSeed(raw, TENANT_A, readSeed(), readJson(SEED_SCHEMA_PATH));
  db.prepare('INSERT INTO tenant_settings (tenant_id) VALUES (?)').run(TENANT_B);
  await importSeed(raw, TENANT_B, readSeed(), readJson(SEED_SCHEMA_PATH));
  const { sql, log } = recording(raw);
  const filament = (tenant: string, manufacturer: string, id?: string): string => {
    fid += 1;
    const fId = id ?? `00000000-0000-4000-8000-0000000f${String(fid).padStart(4, '0')}`;
    db.prepare(
      "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, ?, 'PLA', 'Red', 'disposable')",
    ).run(tenant, fId, manufacturer);
    return fId;
  };
  const clip = (
    tenant: string,
    filamentId: string,
    location: string | null,
    state: 'on_spool' | 'spool_empty' | 'free' = 'on_spool',
  ): string => {
    n += 1;
    const id = `00000000-0000-4000-8000-0000000e${String(n).padStart(4, '0')}`;
    db.prepare(
      'INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(tenant, id, `KHE${String(n).padStart(9, '0')}`, filamentId, location, state);
    return id;
  };
  const boxed = (tenant: string, filamentId: string, location: string, count: number): void => {
    n += 1;
    db.prepare(
      "INSERT INTO stock_line (tenant_id, id, filament_id, location_id, pack, count) VALUES (?, ?, ?, ?, 'spool', ?)",
    ).run(
      tenant,
      `00000000-0000-4000-8000-0000000d${String(n).padStart(4, '0')}`,
      filamentId,
      location,
      count,
    );
  };
  const set = (id: string, capacity: number, prefers: string | null = null, tenant = TENANT_A) => {
    db.prepare(
      'UPDATE location SET capacity = ?, prefers_manufacturer = ? WHERE tenant_id = ? AND id = ?',
    ).run(capacity, prefers, tenant, id);
  };
  const tagContainer = (tenant: string, tag: string, container: string): void => {
    db.prepare(
      "INSERT INTO tag (tenant_id, tag_id, kind, target_id) VALUES (?, ?, 'location', ?)",
    ).run(tenant, tag, container);
  };
  for (const [tag, container] of Object.entries(CONTAINERS)) tagContainer(TENANT_A, tag, container);
  const appFor = (tenant: string, auth?: AuthProvider) =>
    createApp({
      auth: auth ?? createDevTokenProvider({ token: TEST_TOKEN, tenantId: tenant }),
      data: (p) => createScopedData(sql, p),
      allowedHosts: ['localhost'],
    });
  const appA = appFor(TENANT_A);
  const appB = appFor(TENANT_B);
  const get = (path: string, tenant = TENANT_A) =>
    (tenant === TENANT_B ? appB : appA).request(`http://localhost${path}`, {
      headers: { host: 'localhost', ...bearer },
    });
  const migrate = (): void => {
    runMigrations(db);
  };
  /**
   * Asks both paths for the same container and clip and checks they agree. The tag path is
   * GET /api/v1/tags/{tag}[?held=]; the list path is the page's own request and view (tapview.js).
   * With `held`, the raw answer must also be exactly { suggestions: [tag's suggestion] or [],
   * held_clip_used }. Returns the shared suggestion and held_clip_used.
   */
  const both = async (tag: string, held?: string, tenant = TENANT_A) => {
    const container = CONTAINERS[tag] ?? (tag === B_TAG ? 'active' : '');
    const viaTagRes = await get(`/api/v1/tags/${tag}${held ? `?held=${held}` : ''}`, tenant);
    expect(viaTagRes.status).toBe(200);
    const viaTag = (await viaTagRes.json()) as ContainerView;
    const holding = held ? { id: held } : null;
    const listRes = await get(tapView.suggestionsPath(container, holding), tenant);
    expect(listRes.status).toBe(200);
    const answer = (await listRes.json()) as unknown;
    if (held) {
      expect(answer).toEqual({
        suggestions: viaTag.suggestion ? [viaTag.suggestion] : [],
        held_clip_used: viaTag.held_clip_used,
      });
    }
    const tree = (await (await get('/api/v1/locations/tree', tenant)).json()) as {
      locations: Place[];
    };
    const node = tapView.findNode(tree.locations, container);
    if (!node) throw new Error(`no ${container}`);
    const page = tapView.browsedView(node, answer, holding);
    expect(page?.suggestion ?? null).toEqual(viaTag.suggestion);
    expect(page?.held_clip_used).toBe(viaTag.held_clip_used);
    return { suggestion: viaTag.suggestion, held_clip_used: viaTag.held_clip_used };
  };
  return { db, sql, log, get, both, filament, clip, boxed, set, tagContainer, migrate, appFor };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a container chosen from the list suggests what its tag suggests (SPOOL-210)', () => {
  it('an on_spool clip: most free, then same filament (other clips only), never a full leaf or its own place', async () => {
    const { both, filament, clip, boxed, set, db, migrate } = await setup({ before0004: true });
    const acme = filament(TENANT_A, 'Acme');
    const other = filament(TENANT_A, 'Other');
    const held = clip(TENANT_A, acme, 'loc1.shelf-1');
    expect(await both(ACTIVE_TAG)).toMatchObject({
      suggestion: { location_id: 'loc1.shelf-2', reason: 'most_free' },
      held_clip_used: false,
    });
    // Boxed stock never makes a leaf "the same filament".
    boxed(TENANT_A, acme, 'loc2.shelf-4', 2);
    migrate();
    expect(await both(ACTIVE_TAG, held)).toMatchObject({
      suggestion: { location_id: 'loc1.shelf-2', reason: 'most_free' },
      held_clip_used: true,
    });
    clip(TENANT_A, acme, 'loc2.shelf-4');
    expect((await both(ACTIVE_TAG, held)).suggestion).toMatchObject({
      location_id: 'loc2.shelf-4',
      reason: 'same_filament',
    });
    // Full at its hard limit: never suggested. A manufacturer preference on an active shelf is ignored.
    for (let i = 0; i < 7; i += 1) clip(TENANT_A, other, 'loc2.shelf-4');
    db.prepare(
      "UPDATE location SET prefers_manufacturer = 'Acme' WHERE tenant_id = ? AND id = 'loc3.shelf-3'",
    ).run(TENANT_A);
    expect((await both(ACTIVE_TAG, held)).suggestion).toMatchObject({
      location_id: 'loc1.shelf-2',
      reason: 'most_free',
    });
    // The clip's own place is never offered, even with the most room (and here inside the container).
    set('loc1.shelf-1', 20);
    expect((await both(ACTIVE_TAG, held)).suggestion).toMatchObject({
      location_id: 'loc1.shelf-2',
    });
    expect((await both(LOC1_TAG, held)).suggestion).toMatchObject({
      location_id: 'loc1.shelf-2',
      reason: 'most_free',
    });
  });

  it('an on_spool clip never goes to clip storage or a passive shelf boxing the same filament', async () => {
    const { both, filament, clip, boxed, set } = await setup();
    const acme = filament(TENANT_A, 'Acme');
    set('clips.bin-1', 50, 'Acme');
    set('closet-storage.shelf-1', 50);
    boxed(TENANT_A, acme, 'closet-storage.shelf-1', 3);
    const held = clip(TENANT_A, acme, 'loc1.shelf-1');
    expect((await both(HOME_TAG, held)).suggestion).toMatchObject({
      location_id: 'loc1.shelf-2',
      type: 'active_storage',
      reason: 'most_free',
    });
  });

  for (const state of ['free', 'spool_empty'] as const) {
    it(`a ${state} clip: clip storage only, manufacturer preference, then most free, then same filament`, async () => {
      const { both, filament, clip, boxed, set, db } = await setup();
      const acme = filament(TENANT_A, 'Acme');
      db.prepare(
        "INSERT INTO location (tenant_id, id, name, type, parent, leaf, capacity, capacity_mode, prefers_manufacturer, tag_source) VALUES (?, 'clips.bin-2', 'Clip bin 2', 'clip_storage', 'clips', 1, 5, 'soft', 'Acme', 'sticker')",
      ).run(TENANT_A);
      set('clips.bin-1', 20);
      set('closet-storage.shelf-1', 50);
      clip(TENANT_A, acme, 'loc2.shelf-2');
      boxed(TENANT_A, acme, 'closet-storage.shelf-1', 3);
      const held = clip(TENANT_A, acme, 'loc2.shelf-1', state);
      for (const tag of [HOME_TAG, CLIPS_TAG]) {
        expect((await both(tag, held)).suggestion).toMatchObject({
          location_id: 'clips.bin-2',
          type: 'clip_storage',
          reason: 'manufacturer_preference',
        });
      }
      db.prepare(
        "UPDATE location SET prefers_manufacturer = NULL WHERE tenant_id = ? AND id = 'clips.bin-2'",
      ).run(TENANT_A);
      expect((await both(HOME_TAG, held)).suggestion).toMatchObject({
        location_id: 'clips.bin-1',
        reason: 'most_free',
      });
      clip(TENANT_A, acme, 'clips.bin-2', 'free');
      expect((await both(HOME_TAG, held)).suggestion).toMatchObject({
        location_id: 'clips.bin-2',
        reason: 'same_filament',
      });
    });
  }

  it('no candidate: an empty list, held_clip_used true, on both paths', async () => {
    const { both, filament, clip, set } = await setup();
    const acme = filament(TENANT_A, 'Acme');
    set('clips.bin-1', 20);
    const onSpool = clip(TENANT_A, acme, 'loc1.shelf-1');
    const free = clip(TENANT_A, acme, null, 'free');
    expect(await both(CLIPS_TAG, onSpool)).toEqual({ suggestion: null, held_clip_used: true });
    expect(await both(ACTIVE_TAG, free)).toEqual({ suggestion: null, held_clip_used: true });
    // Slots only, and shelves without capacity: nothing to suggest for anyone.
    expect(await both(AMS_TAG, onSpool)).toEqual({ suggestion: null, held_clip_used: true });
    expect(await both(PASSIVE_TAG, onSpool)).toEqual({ suggestion: null, held_clip_used: true });
  });

  it('a held clip that sits in a slot gets no suggestion', async () => {
    const { both, filament, clip } = await setup();
    const loaded = clip(TENANT_A, filament(TENANT_A, 'Acme'), 'dreammaker.ams-a.slot-1');
    expect(await both(ACTIVE_TAG, loaded)).toEqual({ suggestion: null, held_clip_used: true });
    expect(await both(HOME_TAG, loaded)).toEqual({ suggestion: null, held_clip_used: true });
  });

  it('nothing held: the page takes the plain list’s first place that is not a slot, as the tag does', async () => {
    const { both, get } = await setup();
    for (const tag of Object.keys(CONTAINERS)) await both(tag);
    // A container of slots only: the plain list (unchanged) offers its slots, the page none of them.
    const slots = (await (
      await get('/api/v1/placement-suggestions?count=1&within=dreammaker.ams-a')
    ).json()) as { suggestions: Suggestion[] };
    expect(slots.suggestions.length).toBeGreaterThan(0);
    expect((await both(AMS_TAG)).suggestion).toBeNull();
    expect((await both(HOME_TAG)).suggestion).toMatchObject({ type: 'active_storage' });
  });

  it('a held clip that is unknown, or another tenant’s, is ignored exactly the same way', async () => {
    const { both, get, log, filament, clip } = await setup();
    const foreign = clip(TENANT_B, filament(TENANT_B, 'Acme'), 'loc1.shelf-1');
    const unknown = '00000000-0000-4000-8000-00000000ffff';
    const plain = await both(ACTIVE_TAG);
    expect(await both(ACTIVE_TAG, unknown)).toEqual({ ...plain, held_clip_used: false });
    expect(await both(ACTIVE_TAG, foreign)).toEqual({ ...plain, held_clip_used: false });
    // Status, headers and body are the same, and so are the statements run (only the id differs).
    const ask = async (held: string) => {
      log.length = 0;
      const res = await full(
        await get(`/api/v1/placement-suggestions?count=1&within=active&held=${held}`),
      );
      return { res, queries: log.map((l) => l.query), params: log.map((l) => l.params) };
    };
    const a = await ask(unknown);
    const b = await ask(foreign);
    expect(b.res).toBe(a.res);
    expect(a.res).toMatch(/^200 /);
    expect(b.queries).toEqual(a.queries);
    expect(b.params).toEqual(a.params.map((p) => p.map((v) => (v === unknown ? foreign : v))));
    // The clip lookup runs, finds nothing, and nothing further is asked about the clip.
    expect(a.queries).toHaveLength(2);
    expect(a.params[1]).toEqual([TENANT_A, unknown]);
  });

  it('ranks with the caller’s own tenant data only (other clips, manufacturer preference)', async () => {
    const { both, filament, clip, set, tagContainer } = await setup();
    // The same filament id and manufacturer in both tenants; every leaf slug exists in both.
    const shared = filament(TENANT_B, 'Acme');
    filament(TENANT_A, 'Acme', shared);
    const heldShelf = clip(TENANT_B, shared, 'loc1.shelf-1');
    const heldFree = clip(TENANT_B, shared, null, 'free');
    tagContainer(TENANT_B, B_TAG, 'active');
    tagContainer(TENANT_B, CLIPS_TAG, 'clips');
    set('clips.bin-1', 20, null, TENANT_A);
    set('clips.bin-1', 20, null, TENANT_B);
    const views = async () => [
      await both(B_TAG, heldShelf, TENANT_B),
      await both(CLIPS_TAG, heldFree, TENANT_B),
    ];
    const before = await views();
    expect(before.map((v) => v.suggestion?.reason)).toEqual(['most_free', 'most_free']);
    // Tenant A: another clip of the same filament id, and a matching manufacturer preference.
    clip(TENANT_A, shared, 'loc2.shelf-3');
    clip(TENANT_A, shared, 'clips.bin-1', 'free');
    set('clips.bin-1', 20, 'Acme', TENANT_A);
    expect(await views()).toEqual(before);
  });
});

describe('placement-suggestions held: another tenant’s rows never count (SPOOL-210)', () => {
  it('room comes from the caller’s own stock: another tenant’s boxed stock on the same slug is not used', async () => {
    const { both, filament, boxed, set } = await setup();
    set('closet-storage.shelf-1', 50);
    set('closet-storage.shelf-2', 40);
    set('closet-storage.shelf-1', 50, null, TENANT_B);
    boxed(TENANT_B, filament(TENANT_B, 'Acme'), 'closet-storage.shelf-1', 20);
    for (const held of [undefined, '00000000-0000-4000-8000-00000000ffff']) {
      expect((await both(PASSIVE_TAG, held)).suggestion).toMatchObject({
        location_id: 'closet-storage.shelf-1',
        free: 50,
      });
    }
  });

  it('a filament id that also exists in another tenant ranks by the caller’s own filament', async () => {
    const { both, filament, clip, set } = await setup();
    // Inserted first in tenant B under another manufacturer, then in A.
    const shared = filament(TENANT_B, 'Acme');
    filament(TENANT_A, 'Plain', shared);
    set('clips.bin-1', 20, 'Acme');
    const held = clip(TENANT_A, shared, null, 'free');
    expect(await both(CLIPS_TAG, held)).toEqual({
      suggestion: expect.objectContaining({
        location_id: 'clips.bin-1',
        reason: 'most_free',
      }) as unknown,
      held_clip_used: true,
    });
  });
});

describe('placement-suggestions held: validation and isolation (SPOOL-210)', () => {
  it('refuses a malformed or repeated held with 400 before anything is looked up', async () => {
    const { get, log } = await setup();
    const id = '00000000-0000-4000-8000-00000000aaaa';
    for (const within of ['active', 'nope']) {
      for (const q of [
        'held=nope',
        'held=',
        `held=${id}&held=${id}`,
        "held=' OR 1=1",
        `held=${id.toUpperCase()}`,
        `held=${id}%00`,
      ]) {
        log.length = 0;
        const res = await get(
          `/api/v1/placement-suggestions?count=1&within=${within}&${q.replace(/ /g, '%20')}`,
        );
        expect(res.status, `${within} ${q}`).toBe(400);
        expect(await res.json()).toEqual({ error: 'invalid_request' });
        expect(log).toEqual([]);
      }
    }
  });

  it('refuses held without within, with type, or with a count other than 1', async () => {
    const { get, log } = await setup();
    const id = '00000000-0000-4000-8000-00000000aaaa';
    for (const q of [
      `count=1&held=${id}`,
      `count=1&within=active&type=active_storage&held=${id}`,
      `count=1&within=active&type=&held=${id}`,
      `count=2&within=active&held=${id}`,
      `within=active&held=${id}`,
    ]) {
      log.length = 0;
      const res = await get(`/api/v1/placement-suggestions?${q}`);
      expect(res.status, q).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_request' });
      expect(log).toEqual([]);
    }
  });

  it('answers the same 404 for an unknown or other tenant’s within, with or without held', async () => {
    const { get, log, db, filament, clip } = await setup();
    db.prepare(
      "INSERT INTO location (tenant_id, id, name, type, parent, leaf, tag_source) VALUES (?, 'b-room', 'B room', 'container', 'home', 0, NULL)",
    ).run(TENANT_B);
    const mine = clip(TENANT_A, filament(TENANT_A, 'Acme'), 'loc1.shelf-1');
    const answers = new Set<string>();
    for (const within of ['nope', 'b-room']) {
      answers.add(await full(await get(`/api/v1/placement-suggestions?count=1&within=${within}`)));
      log.length = 0;
      answers.add(
        await full(
          await get(`/api/v1/placement-suggestions?count=1&within=${within}&held=${mine}`),
        ),
      );
      // Only the tree was read: the clip is never looked up for a place the caller cannot see.
      expect(log.map((l) => l.params)).toEqual([[TENANT_A]]);
    }
    expect(answers.size).toBe(1);
    expect([...answers][0]).toMatch(/^404 .*\{"error":"not_found"\}$/);
  });

  it('needs the read scope, with or without held', async () => {
    const { appFor } = await setup();
    const auth: AuthProvider = {
      authenticate: () =>
        Promise.resolve({ subject: 'x', tenantId: TENANT_A, scopes: new Set<string>() }),
    };
    const app = appFor(TENANT_A, auth);
    for (const q of [
      'count=1&within=active',
      'count=1&within=active&held=00000000-0000-4000-8000-00000000aaaa',
    ]) {
      const res = await app.request(`http://localhost/api/v1/placement-suggestions?${q}`, {
        headers: { host: 'localhost' },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden' });
    }
  });

  it('logs nothing, so no clip or place id reaches a log', async () => {
    const { get, filament, clip } = await setup();
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const held = clip(TENANT_A, filament(TENANT_A, 'Acme'), 'loc1.shelf-1');
    for (const q of [
      `count=1&within=active&held=${held}`,
      'count=1&within=active&held=00000000-0000-4000-8000-00000000ffff',
      `count=1&within=nope&held=${held}`,
      'count=1&within=active&held=bad',
    ]) {
      await get(`/api/v1/placement-suggestions?${q}`);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
