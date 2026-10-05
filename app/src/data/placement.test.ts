// SPDX-License-Identifier: AGPL-3.0-or-later
// The tree, placement check and suggestions against a real database and the real HTTP app.
import { describe, expect, it } from 'vitest';
import { createDevTokenProvider } from '../auth/dev-token.ts';
import { Scope, type AuthProvider } from '../auth/principal.ts';
import { createApp, parseCount } from '../http/app.ts';
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
import { createScopedData } from './scoped.ts';
import type { LocationNode, PlacementCheck, PlacementSuggestion } from './tree.ts';

const HOSTS = ['localhost'];
const bearer = { authorization: `Bearer ${TEST_TOKEN}` };

/** Tag IDs are 12 characters of Crockford base32; tests only need distinct valid ones. */
function tag(n: number): string {
  return `T${String(n).padStart(11, '0')}`;
}

async function setup() {
  const { sql, db } = memoryDatabase();
  await importSeed(sql, TENANT_A, readSeed(), readJson(SEED_SCHEMA_PATH));
  db.prepare('INSERT INTO tenant_settings (tenant_id) VALUES (?)').run(TENANT_B);
  await importSeed(sql, TENANT_B, readSeed(), readJson(SEED_SCHEMA_PATH));
  const filament = uuid();
  for (const tenant of [TENANT_A, TENANT_B]) {
    db.prepare(
      "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, 'Demo', 'PLA', 'Black', 'disposable')",
    ).run(tenant, tenant === TENANT_A ? filament : uuid());
  }
  const app = createApp({
    auth: createDevTokenProvider({ token: TEST_TOKEN, tenantId: TENANT_A }),
    data: (principal) => createScopedData(sql, principal),
    allowedHosts: HOSTS,
  });
  const clips = (tenant: string, location: string, n: number, from = 0): void => {
    const f = db.prepare('SELECT id FROM filament WHERE tenant_id = ?').get(tenant) as unknown as {
      id: string;
    };
    for (let i = 0; i < n; i += 1) {
      db.prepare(
        "INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, ?, ?, ?, ?, 'on_spool')",
      ).run(tenant, uuid(), tag(from + i), f.id, location);
    }
  };
  const get = (path: string, headers: Record<string, string> = bearer) =>
    app.request(`http://localhost${path}`, { headers: { host: 'localhost', ...headers } });
  return { app, db, sql, get, clips };
}

function find(nodes: LocationNode[], id: string): LocationNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const inner = find(n.children, id);
    if (inner) return inner;
  }
  return undefined;
}

describe('GET /api/v1/locations/tree', () => {
  it('returns Home with every container and leaf of the seed', async () => {
    const { get } = await setup();
    const res = await get('/api/v1/locations/tree');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { locations } = (await res.json()) as { locations: LocationNode[] };
    expect(locations).toHaveLength(1);
    expect(locations[0]).toMatchObject({ id: 'home', leaf: false, used: 0, capacity: 107 + 30 });
    expect(find(locations, 'loc1.shelf-1')).toMatchObject({ capacity: 16, capacity_mode: 'hard' });
  });

  it('derives used and free from clips and boxed stock at the location', async () => {
    const { get, clips, db } = await setup();
    clips(TENANT_A, 'loc1.shelf-1', 10);
    const f = db
      .prepare('SELECT id FROM filament WHERE tenant_id = ?')
      .get(TENANT_A) as unknown as { id: string };
    db.prepare(
      "INSERT INTO stock_line (tenant_id, id, filament_id, location_id, pack, count) VALUES (?, ?, ?, 'closet-storage.shelf-1', 'spool', 3)",
    ).run(TENANT_A, uuid(), f.id);
    const { locations } = (await (await get('/api/v1/locations/tree')).json()) as {
      locations: LocationNode[];
    };
    expect(find(locations, 'loc1.shelf-1')).toMatchObject({ used: 10, free: 6 });
    expect(find(locations, 'closet-storage.shelf-1')).toMatchObject({
      used: 3,
      capacity: null,
      free: null,
    });
    expect(find(locations, 'loc1')).toMatchObject({ used: 10, free: 32 - 10 });
  });

  it("never counts another tenant's clips", async () => {
    const { get, clips } = await setup();
    clips(TENANT_B, 'loc1.shelf-1', 5);
    const { locations } = (await (await get('/api/v1/locations/tree')).json()) as {
      locations: LocationNode[];
    };
    expect(find(locations, 'loc1.shelf-1')).toMatchObject({ used: 0, free: 16 });
  });

  it('answers 401 without a token and 403 without the scope', async () => {
    const { get, sql } = await setup();
    expect((await get('/api/v1/locations/tree', {})).status).toBe(401);
    const noScope: AuthProvider = {
      authenticate: () =>
        Promise.resolve({ subject: 'x', tenantId: TENANT_A, scopes: new Set<string>() }),
    };
    const app = createApp({
      auth: noScope,
      data: (p) => createScopedData(sql, p),
      allowedHosts: HOSTS,
    });
    for (const path of [
      '/api/v1/locations/tree',
      '/api/v1/locations/loc1.shelf-1/placement?count=1',
      '/api/v1/placement-suggestions?count=1',
    ]) {
      const res = await app.request(`http://localhost${path}`, { headers: { host: 'localhost' } });
      expect(res.status, path).toBe(403);
    }
  });

  it('shows a tenant with no locations an empty tree', async () => {
    const { sql, db } = await setup();
    const third = '9d1f2c4e-0b7a-4e3f-8a55-1c2d3e4f5a6b';
    db.prepare('INSERT INTO tenant_settings (tenant_id) VALUES (?)').run(third);
    const data = createScopedData(sql, {
      subject: 's',
      tenantId: third,
      scopes: new Set([Scope.LocationsRead]),
    });
    expect(await data.locationTree()).toEqual([]);
  });
});

describe('GET /api/v1/locations/:id/placement', () => {
  it('is ok with room, and warns past a hard limit (16 places, 10 used)', async () => {
    const { get, clips } = await setup();
    clips(TENANT_A, 'loc1.shelf-1', 10);
    const ok = (await (
      await get('/api/v1/locations/loc1.shelf-1/placement?count=6')
    ).json()) as PlacementCheck;
    expect(ok).toMatchObject({ outcome: 'ok', free: 6, free_after: 0, capacity_mode: 'hard' });
    const warn = (await (
      await get('/api/v1/locations/loc1.shelf-1/placement?count=7')
    ).json()) as PlacementCheck;
    expect(warn).toMatchObject({ outcome: 'warning', free_after: -1 });
  });

  it('allows past a soft limit with a notice', async () => {
    const { get, clips, db } = await setup();
    db.prepare("UPDATE location SET capacity = 2 WHERE id = 'clips.bin-1' AND tenant_id = ?").run(
      TENANT_A,
    );
    clips(TENANT_A, 'clips.bin-1', 2);
    const res = (await (
      await get('/api/v1/locations/clips.bin-1/placement?count=1')
    ).json()) as PlacementCheck;
    expect(res).toMatchObject({ outcome: 'notice', capacity_mode: 'soft', free_after: -1 });
  });

  it('says capacity is not set for a passive shelf with no capacity', async () => {
    const { get } = await setup();
    const res = (await (
      await get('/api/v1/locations/closet-storage.shelf-1/placement?count=3')
    ).json()) as PlacementCheck;
    expect(res).toMatchObject({ outcome: 'capacity_not_set', capacity: null, free: null });
  });

  it('holds at most one clip in an active_use slot', async () => {
    const { get, clips } = await setup();
    const slot = (await (await get('/api/v1/locations/tree')).json()) as {
      locations: LocationNode[];
    };
    const slotId = findFirstSlot(slot.locations);
    expect(
      (
        (await (
          await get(`/api/v1/locations/${slotId}/placement?count=1`)
        ).json()) as PlacementCheck
      ).outcome,
    ).toBe('ok');
    expect(
      (
        (await (
          await get(`/api/v1/locations/${slotId}/placement?count=2`)
        ).json()) as PlacementCheck
      ).outcome,
    ).toBe('warning');
    clips(TENANT_A, slotId, 1);
    expect(
      (
        (await (
          await get(`/api/v1/locations/${slotId}/placement?count=1`)
        ).json()) as PlacementCheck
      ).outcome,
    ).toBe('warning');
  });

  it('answers for a container: room is added up over the leaves inside', async () => {
    const { get } = await setup();
    const res = await get('/api/v1/locations/loc1/placement?count=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlacementCheck;
    expect(body.scope).toBe('container');
    expect(body.location_id).toBe('loc1');
    expect(body.leaves_counted).toBeGreaterThan(0);
    const home = (await (
      await get('/api/v1/locations/home/placement?count=1')
    ).json()) as PlacementCheck;
    expect(home.scope).toBe('container');
  });

  it('reports the leaf scope for a leaf', async () => {
    const { get } = await setup();
    const body = (await (
      await get('/api/v1/locations/loc1.shelf-1/placement?count=1')
    ).json()) as PlacementCheck;
    expect(body).toMatchObject({
      scope: 'leaf',
      leaves_counted: 1,
      leaves_without_capacity: 0,
      fits_in_one_place: true,
    });
  });

  it("answers 404 for an unknown id and for another tenant's id alike", async () => {
    const { get, sql, db } = await setup();
    // A location that exists only for tenant B.
    db.prepare(
      "INSERT INTO location (tenant_id, id, name, type, parent, leaf, capacity, capacity_mode, tag_source) VALUES (?, 'b-only', 'B only', 'passive_storage', 'passive', 1, 5, 'soft', 'sticker')",
    ).run(TENANT_B);
    const other = await get('/api/v1/locations/b-only/placement?count=1');
    const unknown = await get('/api/v1/locations/no-such-place/placement?count=1');
    expect(other.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await other.text()).toBe(await unknown.text());
    const asB = createScopedData(sql, {
      subject: 'b',
      tenantId: TENANT_B,
      scopes: new Set([Scope.LocationsRead]),
    });
    expect(await asB.placementCheck('b-only', 1)).toMatchObject({ outcome: 'ok' });
  });

  it.each([
    ['count=0'],
    ['count=-1'],
    ['count=1.5'],
    ['count=1e3'],
    ['count=01'],
    ['count=1001'],
    ['count= 1'],
    ['count='],
    [''],
    ['count=1&count=2x'],
  ])('rejects the query %j with 400', async (query) => {
    const { get } = await setup();
    const res = await get(`/api/v1/locations/loc1.shelf-1/placement?${query}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
  });

  it.each([
    ['UPPER', 400],
    ['a..b', 400],
    ['-a', 400],
    ['a_b', 400],
    ['a'.repeat(65), 400],
    ['a%00b', 400],
    ['a%2Fb', 400],
  ])('rejects the location id %j with %i', async (id, status) => {
    const { get } = await setup();
    const res = await get(`/api/v1/locations/${id}/placement?count=1`);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
  });

  it('never leaves the API for a dot-segment id: it is not a location route', async () => {
    const { get } = await setup();
    const res = await get('/api/v1/locations/%2e%2e/placement?count=1');
    expect([400, 404]).toContain(res.status);
  });

  it("answers 404 for another tenant's container id", async () => {
    const { get, db } = await setup();
    db.prepare(
      "INSERT INTO location (tenant_id, id, name, type, parent, leaf, tag_source) VALUES (?, 'b-room', 'B room', 'container', 'home', 0, NULL)",
    ).run(TENANT_B);
    const res = await get('/api/v1/locations/b-room/placement?count=1');
    expect(res.status).toBe(404);
  });

  it("does not count another tenant's boxed stock", async () => {
    const { get, db } = await setup();
    const f = db
      .prepare('SELECT id FROM filament WHERE tenant_id = ?')
      .get(TENANT_B) as unknown as { id: string };
    db.prepare(
      "INSERT INTO stock_line (tenant_id, id, filament_id, location_id, pack, count) VALUES (?, ?, ?, 'closet-storage.shelf-1', 'spool', 7)",
    ).run(TENANT_B, uuid(), f.id);
    const { locations } = (await (await get('/api/v1/locations/tree')).json()) as {
      locations: LocationNode[];
    };
    expect(find(locations, 'closet-storage.shelf-1')).toMatchObject({ used: 0 });
  });
});

describe('GET /api/v1/placement-suggestions?within=', () => {
  it('limits suggestions to the chosen container', async () => {
    const { get } = await setup();
    const res = await get('/api/v1/placement-suggestions?count=1&within=loc1');
    expect(res.status).toBe(200);
    const { suggestions } = (await res.json()) as { suggestions: { location_id: string }[] };
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.every((s) => s.location_id.startsWith('loc1.'))).toBe(true);
  });

  it("answers 404 for an unknown id and for another tenant's id", async () => {
    const { get, db } = await setup();
    db.prepare(
      "INSERT INTO location (tenant_id, id, name, type, parent, leaf, tag_source) VALUES (?, 'b-room', 'B room', 'container', 'home', 0, NULL)",
    ).run(TENANT_B);
    expect((await get('/api/v1/placement-suggestions?count=1&within=b-room')).status).toBe(404);
    expect((await get('/api/v1/placement-suggestions?count=1&within=nope')).status).toBe(404);
  });

  it('accepts a leaf as within and returns only that leaf', async () => {
    const { get } = await setup();
    const res = await get('/api/v1/placement-suggestions?count=1&within=loc1.shelf-1');
    const { suggestions } = (await res.json()) as { suggestions: { location_id: string }[] };
    expect(suggestions.map((s) => s.location_id)).toEqual(['loc1.shelf-1']);
  });

  it('refuses a bad or repeated within', async () => {
    const { get } = await setup();
    for (const q of ['within=', 'within=a&within=b', 'within=%2e%2e', `within=${'a'.repeat(65)}`]) {
      expect((await get(`/api/v1/placement-suggestions?count=1&${q}`)).status).toBe(400);
    }
  });
});

describe('GET /api/v1/placement-suggestions', () => {
  it('leaves out unset-capacity leaves and full leaves, with the most free first', async () => {
    const { get, clips } = await setup();
    clips(TENANT_A, 'loc1.shelf-1', 16, 0);
    const res = await get('/api/v1/placement-suggestions?count=1&type=active_storage');
    expect(res.status).toBe(200);
    const { suggestions } = (await res.json()) as { suggestions: PlacementSuggestion[] };
    const ids = suggestions.map((s) => s.location_id);
    expect(ids).not.toContain('loc1.shelf-1');
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]?.free).toBe(16);
    expect(ids[0]).toBe('loc1.shelf-2');
  });

  it('does not suggest active_use slots unless asked for by type', async () => {
    const { get } = await setup();
    const all = (await (await get('/api/v1/placement-suggestions?count=1')).json()) as {
      suggestions: PlacementSuggestion[];
    };
    expect(all.suggestions.every((s) => s.type !== 'active_use')).toBe(true);
    const slots = (await (
      await get('/api/v1/placement-suggestions?count=1&type=active_use')
    ).json()) as {
      suggestions: PlacementSuggestion[];
    };
    expect(slots.suggestions.length).toBeGreaterThan(0);
    expect(slots.suggestions.every((s) => s.type === 'active_use')).toBe(true);
  });

  it('never suggests a passive shelf while its capacity is not set', async () => {
    const { get } = await setup();
    const { suggestions } = (await (
      await get('/api/v1/placement-suggestions?count=1&type=passive_storage')
    ).json()) as {
      suggestions: PlacementSuggestion[];
    };
    expect(suggestions).toEqual([]);
  });

  it.each([
    'count=0',
    'count=1&count=2',
    'count=1&type=active_storage&type=active_use',
    'count=1&type=container',
    'count=1&type=nope',
    'type=active_storage',
    'count=1&type=',
  ])('rejects %j with 400', async (query) => {
    const { get } = await setup();
    expect((await get(`/api/v1/placement-suggestions?${query}`)).status).toBe(400);
  });
});

describe('parseCount', () => {
  it.each([
    ['1', 1],
    ['10', 10],
    ['1000', 1000],
  ])('accepts %s', (text, expected) => {
    expect(parseCount(text)).toBe(expected);
  });
  it.each([undefined, '', '0', '-1', '1.0', '1e2', '0x10', ' 1', '1 ', '1001', '99999', '٣'])(
    'rejects %j',
    (text) => {
      expect(parseCount(text)).toBeNull();
    },
  );
});

function findFirstSlot(nodes: LocationNode[]): string {
  for (const n of nodes) {
    if (n.leaf && n.type === 'active_use') return n.id;
    const inner = n.children.length > 0 ? findFirstSlot(n.children) : '';
    if (inner) return inner;
  }
  return '';
}
