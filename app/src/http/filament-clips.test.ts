// SPDX-License-Identifier: AGPL-3.0-or-later
// SPOOL-211: GET /api/v1/filaments/:id/clips over the real HTTP application and SQL adapter. The
// non-NFC way to find where a spool belongs: every clip of one filament, with or without a place.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDevTokenProvider } from '../auth/dev-token.ts';
import { ForbiddenError, Scope } from '../auth/principal.ts';
import { createScopedData } from '../data/scoped.ts';
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

const bearer = { authorization: `Bearer ${TEST_TOKEN}` };

interface Clip {
  id: string;
  state: string;
  location_id: string | null;
  filament: { manufacturer: string; type: string; color: string };
}

async function setup() {
  const { sql, db } = memoryDatabase();
  await importSeed(sql, TENANT_A, readSeed(), readJson(SEED_SCHEMA_PATH));
  await importSeed(sql, TENANT_B, readSeed(), readJson(SEED_SCHEMA_PATH));
  const filament = (tenant: string, id: string, manufacturer: string, color: string): string => {
    db.prepare(
      "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, ?, 'PLA', ?, 'disposable')",
    ).run(tenant, id, manufacturer, color);
    return id;
  };
  let n = 0;
  const clip = (
    tenant: string,
    filamentId: string,
    location: string | null,
    state = 'on_spool',
  ): string => {
    n += 1;
    const id = uuid();
    db.prepare(
      'INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(tenant, id, `FC${String(n).padStart(10, '0')}`, filamentId, location, state);
    return id;
  };
  // The same filament id in both tenants, with different names: B's clips and B's names must never
  // show in A's list, and A's clips must not be joined to B's filament row.
  const shared = filament(TENANT_A, uuid(), 'Acme', 'Red');
  filament(TENANT_B, shared, 'Other', 'Blue');
  const onlyB = filament(TENANT_B, uuid(), 'Other', 'Green');
  const empty = filament(TENANT_A, uuid(), 'Acme', 'White');
  const a1 = clip(TENANT_A, shared, 'loc1.shelf-1');
  const bClip = clip(TENANT_B, shared, 'loc1.shelf-1');
  const a2 = clip(TENANT_A, shared, null, 'free');
  const a3 = clip(TENANT_A, shared, 'clips.bin-1', 'spool_empty');
  clip(TENANT_B, onlyB, 'loc1.shelf-2');
  const as = (tenantId: string, scopes: string[]) =>
    createApp({
      auth: {
        authenticate: () => Promise.resolve({ subject: 's', tenantId, scopes: new Set(scopes) }),
      },
      data: (p) => createScopedData(sql, p),
      allowedHosts: ['localhost'],
    });
  const app = createApp({
    auth: createDevTokenProvider({ token: TEST_TOKEN, tenantId: TENANT_A }),
    data: (p) => createScopedData(sql, p),
    allowedHosts: ['localhost'],
  });
  const call = (path: string, a = app, headers: Record<string, string> = bearer) =>
    a.request(`http://localhost${path}`, { headers: { host: 'localhost', ...headers } });
  const clipsOf = async (id: string, a = app): Promise<Clip[]> =>
    ((await (await call(`/api/v1/filaments/${id}/clips`, a)).json()) as { clips: Clip[] }).clips;
  // Every data-layer method the handler touches, by name, to show a refusal makes no lookup at all.
  const dataCalls: string[] = [];
  const counted = createApp({
    auth: createDevTokenProvider({ token: TEST_TOKEN, tenantId: TENANT_A }),
    data: (p) =>
      new Proxy(createScopedData(sql, p), {
        get(target, key, receiver) {
          dataCalls.push(String(key));
          return Reflect.get(target, key, receiver) as unknown;
        },
      }),
    allowedHosts: ['localhost'],
  });
  return {
    db,
    sql,
    app,
    as,
    call,
    clip,
    clipsOf,
    counted,
    dataCalls,
    shared,
    onlyB,
    empty,
    a1,
    a2,
    a3,
    bClip,
  };
}

/** Status, every header and the body, as one comparable string. */
async function full(res: Response): Promise<string> {
  return `${String(res.status)} ${JSON.stringify([...res.headers])} ${await res.text()}`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/v1/filaments/:id/clips (SPOOL-211)', () => {
  it('lists every clip of the filament, including one with no place, in the clip-list shape', async () => {
    const { call, shared, a1, a2, a3 } = await setup();
    const res = await call(`/api/v1/filaments/${shared}/clips`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { clips: Clip[] };
    // Exactly the shape GET /api/v1/locations/:id/clips gives each item: no tag ID, nothing else.
    expect(body).toEqual({
      clips: [
        {
          id: a1,
          state: 'on_spool',
          location_id: 'loc1.shelf-1',
          filament: { manufacturer: 'Acme', type: 'PLA', color: 'Red' },
        },
        {
          id: a2,
          state: 'free',
          location_id: null,
          filament: { manufacturer: 'Acme', type: 'PLA', color: 'Red' },
        },
        {
          id: a3,
          state: 'spool_empty',
          location_id: 'clips.bin-1',
          filament: { manufacturer: 'Acme', type: 'PLA', color: 'Red' },
        },
      ],
    });
  });

  it('gives the item shape of the clips-at-a-place list, key for key', async () => {
    const { call, shared, a1 } = await setup();
    const atPlace = (await (await call('/api/v1/locations/loc1.shelf-1/clips')).json()) as {
      clips: Clip[];
    };
    const ofFilament = (await (await call(`/api/v1/filaments/${shared}/clips`)).json()) as {
      clips: Clip[];
    };
    expect(ofFilament.clips.find((c) => c.id === a1)).toEqual(
      atPlace.clips.find((c) => c.id === a1),
    );
  });

  it('answers an empty list for a filament with no clips', async () => {
    const { call, empty } = await setup();
    const res = await call(`/api/v1/filaments/${empty}/clips`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clips: [] });
  });

  it('never shows another tenant’s clips or names for a filament with the same id', async () => {
    const { as, clipsOf, shared, a1, a2, a3, bClip } = await setup();
    const listA = await clipsOf(shared);
    expect(listA.map((c) => c.id)).toEqual([a1, a2, a3]);
    expect(listA.every((c) => c.filament.manufacturer === 'Acme')).toBe(true);
    const listB = await clipsOf(shared, as(TENANT_B, [Scope.LocationsRead]));
    expect(listB.map((c) => c.id)).toEqual([bClip]);
    expect(listB[0]?.filament).toEqual({ manufacturer: 'Other', type: 'PLA', color: 'Blue' });
  });

  it('answers an unknown and another tenant’s filament with the very same 404', async () => {
    const { call, onlyB } = await setup();
    const unknown = await full(await call(`/api/v1/filaments/${uuid()}/clips`));
    const otherTenant = await full(await call(`/api/v1/filaments/${onlyB}/clips`));
    expect(unknown).toBe(otherTenant);
    expect(unknown.startsWith('404 ')).toBe(true);
    expect(unknown.endsWith(' {"error":"not_found"}')).toBe(true);
    // The same 404 as the filament's stock route gives for that id.
    expect(await full(await call(`/api/v1/filaments/${onlyB}/stock`))).toBe(otherTenant);
  });

  it('refuses a malformed id with 400 before any lookup', async () => {
    const { call, shared } = await setup();
    for (const bad of [
      'not-a-uuid',
      'ABCDEF00-0000-4000-8000-000000000001',
      `${shared}0`,
      shared.slice(1),
      `${shared}%20`,
      `${shared.slice(0, -1)}%00`,
    ]) {
      const res = await call(`/api/v1/filaments/${bad}/clips`);
      expect(res.status, bad).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_request' });
    }
  });

  it('makes no data lookup at all for a malformed id', async () => {
    const { call, counted, dataCalls, shared } = await setup();
    for (const bad of ['not-a-uuid', 'ABCDEF00-0000-4000-8000-000000000001', `${shared}0`]) {
      expect((await call(`/api/v1/filaments/${bad}/clips`, counted)).status).toBe(400);
    }
    expect(dataCalls).toEqual([]);
    // The same counter does see a well-formed id reach the data layer.
    expect((await call(`/api/v1/filaments/${shared}/clips`, counted)).status).toBe(200);
    expect(dataCalls).toEqual(['clipsOf']);
  });

  it('refuses a principal without the read scope in the data layer too', async () => {
    const { sql, shared } = await setup();
    const principal = (scopes: string[]) => ({
      subject: 's',
      tenantId: TENANT_A,
      scopes: new Set(scopes),
    });
    await expect(createScopedData(sql, principal([])).clipsOf(shared)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      createScopedData(sql, principal([Scope.InventoryWrite])).clipsOf(shared),
    ).rejects.toThrow(/missing scope/);
  });

  it('returns at most 200 clips, the first 200 recorded, in a stable order', async () => {
    const { clip, clipsOf, empty } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 205; i += 1) {
      // Places and no place interleaved: the order is the order recorded, not by place.
      ids.push(
        clip(TENANT_A, empty, i % 3 === 0 ? null : i % 3 === 1 ? 'loc2.shelf-1' : 'clips.bin-1'),
      );
    }
    const first = await clipsOf(empty);
    expect(first).toHaveLength(200);
    expect(first.map((c) => c.id)).toEqual(ids.slice(0, 200));
    expect((await clipsOf(empty)).map((c) => c.id)).toEqual(first.map((c) => c.id));
  });

  it('needs a sign-in, and refuses a token without the read scope as the other read routes do', async () => {
    const { as, call, shared } = await setup();
    expect((await call(`/api/v1/filaments/${shared}/clips`, undefined, {})).status).toBe(401);
    const writeOnly = as(TENANT_A, [Scope.InventoryWrite]);
    const refused = await full(await call(`/api/v1/filaments/${shared}/clips`, writeOnly));
    expect(refused.startsWith('403 ')).toBe(true);
    expect(refused).toBe(await full(await call(`/api/v1/filaments/${shared}/stock`, writeOnly)));
    // The scope is checked before the id: a malformed id with no read scope is still 403.
    expect((await call('/api/v1/filaments/not-a-uuid/clips', writeOnly)).status).toBe(403);
  });

  it('logs nothing, whether it answers 200, 400 or 404', async () => {
    const { call, shared, onlyB } = await setup();
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    await call(`/api/v1/filaments/${shared}/clips`);
    await call(`/api/v1/filaments/${onlyB}/clips`);
    await call('/api/v1/filaments/nope/clips');
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('answers only GET', async () => {
    const { app, shared } = await setup();
    const res = await app.request(`http://localhost/api/v1/filaments/${shared}/clips`, {
      method: 'POST',
      headers: { host: 'localhost', ...bearer },
    });
    expect(res.status).toBe(404);
  });
});
