// SPDX-License-Identifier: AGPL-3.0-or-later
// SPOOL-45: sessions, the tag route, tag lookup and moving a clip, over the real HTTP application.
import { describe, expect, it } from 'vitest';
import { createDevTokenProvider } from '../auth/dev-token.ts';
import { Scope, type Principal } from '../auth/principal.ts';
import { createMemorySessionStore } from '../auth/session.ts';
import { createScopedData } from '../data/scoped.ts';
import { newTagId } from '../data/tags.ts';
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

const CODE = 'TEST22';
const CLIP_TAG = 'ABCDEFGHJK12';
const SHELF_TAG = 'MNPQRSTVWX34';
const SHELL = '<!doctype html><title>shell</title>';
const bearer = { authorization: `Bearer ${TEST_TOKEN}` };
const json = { 'content-type': 'application/json' };

interface Options {
  scopes?: string[];
  rateLimits?: { resolverPerMinute?: number; failedAuthPerMinute?: number };
  sessions?: boolean;
}

async function setup(options: Options = {}) {
  const { sql, db } = memoryDatabase();
  await importSeed(sql, TENANT_A, readSeed(), readJson(SEED_SCHEMA_PATH));
  db.prepare('INSERT INTO tenant_settings (tenant_id) VALUES (?)').run(TENANT_B);

  const filament = (tenant: string, color: string): string => {
    const id = uuid();
    db.prepare(
      "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, 'Acme', 'PLA', ?, 'disposable')",
    ).run(tenant, id, color);
    return id;
  };
  const clip = (tenant: string, filamentId: string, tag: string, location: string | null) => {
    const id = uuid();
    db.prepare(
      "INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, ?, ?, ?, ?, 'on_spool')",
    ).run(tenant, id, tag, filamentId, location);
    return id;
  };
  const red = filament(TENANT_A, 'Red');
  const clipId = clip(TENANT_A, red, CLIP_TAG, 'loc1.shelf-1');
  db.prepare('UPDATE location SET tag_id = ? WHERE tenant_id = ? AND id = ?').run(
    SHELF_TAG,
    TENANT_A,
    'closet-storage.shelf-1',
  );
  // Tenant B uses the very same tag IDs for its own things.
  const blue = filament(TENANT_B, 'Blue');
  db.prepare(
    `INSERT INTO location (tenant_id, id, name, type, leaf, capacity, capacity_mode, tag_id, tag_source)
     VALUES (?, 'b-shelf', 'B shelf', 'passive_storage', 1, 9, 'soft', ?, 'sticker')`,
  ).run(TENANT_B, SHELF_TAG);
  const clipB = clip(TENANT_B, blue, CLIP_TAG, 'b-shelf');

  const principalFor = (tenantId: string, scopes: string[]): Principal => ({
    subject: tenantId,
    tenantId,
    scopes: new Set(scopes),
  });
  const scopes = options.scopes ?? [Scope.LocationsRead, Scope.InventoryWrite];
  const sessions = createMemorySessionStore();
  const app = createApp({
    auth: createDevTokenProvider({ token: TEST_TOKEN, tenantId: TENANT_A }),
    data: (p) => createScopedData(sql, p),
    allowedHosts: ['localhost'],
    ...(options.sessions === false ? {} : { sessions }),
    tagPages: { instanceCode: CODE, shell: SHELL },
    ...(options.rateLimits ? { rateLimits: options.rateLimits } : {}),
  });
  const asTenant = (tenantId: string, tenantScopes = scopes) =>
    createApp({
      auth: { authenticate: () => Promise.resolve(principalFor(tenantId, tenantScopes)) },
      data: (p) => createScopedData(sql, p),
      allowedHosts: ['localhost'],
    });
  const request = (
    path: string,
    init: RequestInit & { app?: ReturnType<typeof createApp> } = {},
  ) => {
    const { app: target, ...rest } = init;
    return (target ?? app).request(`http://localhost${path}`, {
      ...rest,
      headers: { host: 'localhost:8787', ...(rest.headers as Record<string, string> | undefined) },
    });
  };
  const events = () =>
    db.prepare('SELECT * FROM event ORDER BY rowid').all() as unknown as {
      type: string;
      clip_id: string;
      from_location_id: string | null;
      to_location_id: string;
    }[];
  const locationOf = (id: string) =>
    (
      db.prepare('SELECT location_id FROM clip WHERE id = ?').get(id) as unknown as {
        location_id: string | null;
      }
    ).location_id;
  const fill = (location: string, n: number) => {
    for (let i = 0; i < n; i += 1) {
      clip(TENANT_A, red, newTagId(), location);
    }
  };
  return {
    app,
    request,
    asTenant,
    db,
    sql,
    clipId,
    clipB,
    events,
    locationOf,
    fill,
    clip,
    red,
    principalFor,
  };
}

describe('the tag route', () => {
  it('serves the same page for any tag of this instance, known or not, in either case', async () => {
    const { request } = await setup();
    const known = await request(`/${CODE}${CLIP_TAG}`);
    const lower = await request(`/${CODE.toLowerCase()}${CLIP_TAG.toLowerCase()}`);
    const unknown = await request(`/${CODE}ZZZZZZZZZZZZ`);
    for (const res of [known, lower, unknown]) {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.text()).toBe(SHELL);
    }
  });

  it('shows one neutral page for a wrong code, a malformed path and anything else', async () => {
    const { request } = await setup();
    const bodies = new Set<string>();
    for (const path of [
      `/OTHER2${CLIP_TAG}`,
      `/${CODE}`,
      `/${CODE}${CLIP_TAG}A`,
      `/${CODE}ABCDEFGHJK1I`,
      `/${CODE}ABCDEFGHJK1-`,
      '/x',
      `/${'a'.repeat(64)}`,
    ]) {
      const res = await request(path);
      expect(res.status, path).toBe(404);
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
    const [page] = [...bodies];
    expect(page).toContain('This tag is not recognised here.');
    // Nothing about any record is in it.
    expect(page).not.toMatch(/Red|Acme|shelf|loc1|closet/i);
  });

  it('never redirects, whatever the path says', async () => {
    const { request } = await setup();
    for (const path of [
      '//evil.example',
      '/\\evil.example',
      '/http://evil.example',
      `/${CODE}${CLIP_TAG}?next=https://evil.example`,
      `/${CODE}${CLIP_TAG}%0d%0aLocation:%20https://evil.example`,
      `/${CODE}${CLIP_TAG}/https://evil.example`,
      '/%2e%2e/evil',
    ]) {
      const res = await request(path);
      expect(res.headers.get('location'), path).toBeNull();
      expect(res.status, path).toBeLessThan(500);
      expect(res.status, path).not.toBe(301);
      expect(res.status, path).not.toBe(302);
    }
  });

  it('is rate limited per caller', async () => {
    const { request } = await setup({ rateLimits: { resolverPerMinute: 3 } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await request(`/${CODE}${CLIP_TAG}`)).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    const limited = await request(`/${CODE}${CLIP_TAG}`);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(await limited.json()).toEqual({ error: 'too_many_requests' });
  });

  it('is off when no instance code is configured', async () => {
    const { sql } = await setup();
    const app = createApp({
      auth: createDevTokenProvider({ token: TEST_TOKEN, tenantId: TENANT_A }),
      data: (p) => createScopedData(sql, p),
      allowedHosts: ['localhost'],
    });
    const res = await app.request(`http://localhost/${CODE}${CLIP_TAG}`, {
      headers: { host: 'localhost' },
    });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('not recognised');
  });
});

describe('sessions', () => {
  async function signIn(request: Awaited<ReturnType<typeof setup>>['request']) {
    const res = await request('/api/v1/session', { method: 'POST', headers: bearer });
    expect(res.status).toBe(204);
    const cookie = res.headers.get('set-cookie') ?? '';
    return { cookie, header: { cookie: cookie.split(';')[0] ?? '' } };
  }

  it('starts a session from the token and sets a hardened cookie', async () => {
    const { request } = await setup();
    const { cookie, header } = await signIn(request);
    expect(cookie).toMatch(/^spoolspot_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=43200');
    expect(cookie).not.toContain('Secure');
    const tree = await request('/api/v1/locations/tree', { headers: header });
    expect(tree.status).toBe(200);
  });

  it('adds Secure and the __Host- prefix over HTTPS, and ignores the plain cookie there', async () => {
    const { app } = await setup();
    const https = (path: string, init: RequestInit = {}) =>
      app.request(`https://localhost${path}`, {
        ...init,
        headers: { host: 'localhost', ...(init.headers as Record<string, string> | undefined) },
      });
    const res = await https('/api/v1/session', { method: 'POST', headers: bearer });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^__Host-spoolspot_session=/);
    expect(cookie).toContain('Secure');
    const value = /=([^;]+)/.exec(cookie)?.[1] ?? '';
    expect(
      (
        await https('/api/v1/locations/tree', {
          headers: { cookie: `__Host-spoolspot_session=${value}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (await https('/api/v1/locations/tree', { headers: { cookie: `spoolspot_session=${value}` } }))
        .status,
    ).toBe(401);
  });

  it('does not trust a forwarded header to decide Secure, and can be told explicitly', async () => {
    const { app, sql } = await setup();
    const spoofed = await app.request('http://localhost/api/v1/session', {
      method: 'POST',
      headers: { host: 'localhost', ...bearer, 'x-forwarded-proto': 'https' },
    });
    expect(spoofed.headers.get('set-cookie')).not.toContain('Secure');
    const behindProxy = createApp({
      auth: createDevTokenProvider({ token: TEST_TOKEN, tenantId: TENANT_A }),
      data: (p) => createScopedData(sql, p),
      allowedHosts: ['localhost'],
      sessions: createMemorySessionStore(),
      secureCookies: true,
    });
    const res = await behindProxy.request('http://localhost/api/v1/session', {
      method: 'POST',
      headers: { host: 'localhost', ...bearer },
    });
    expect(res.headers.get('set-cookie')).toMatch(/^__Host-spoolspot_session=.*; Secure/);
  });

  it('refuses a wrong token and a missing, malformed or unknown cookie alike', async () => {
    const { request } = await setup();
    const bad = await request('/api/v1/session', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(bad.status).toBe(401);
    for (const cookie of ['', 'spoolspot_session=short', `spoolspot_session=${'A'.repeat(43)}`]) {
      const res = await request('/api/v1/locations/tree', { headers: cookie ? { cookie } : {} });
      expect(res.status, cookie).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
  });

  it('will not start a session from a session', async () => {
    const { request } = await setup();
    const { header } = await signIn(request);
    const res = await request('/api/v1/session', {
      method: 'POST',
      headers: { ...header, origin: 'http://localhost:8787' },
    });
    expect(res.status).toBe(401);
  });

  it('signs out: the cookie is cleared and the session stops working', async () => {
    const { request } = await setup();
    const { header } = await signIn(request);
    const out = await request('/api/v1/session', {
      method: 'DELETE',
      headers: { ...header, origin: 'http://localhost:8787' },
    });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await request('/api/v1/locations/tree', { headers: header })).status).toBe(401);
  });

  it('answers 404 for the session routes when sessions are not configured', async () => {
    const { request } = await setup({ sessions: false });
    expect((await request('/api/v1/session', { method: 'POST', headers: bearer })).status).toBe(
      404,
    );
    expect((await request('/api/v1/session', { method: 'DELETE', headers: bearer })).status).toBe(
      404,
    );
  });

  it('refuses a cookie-signed change that does not come from this site (CSRF)', async () => {
    const { request, clipId, locationOf } = await setup();
    const { header } = await signIn(request);
    const body = JSON.stringify({ to: 'loc1.shelf-2' });
    const attempts: Record<string, string>[] = [
      {},
      { origin: 'https://evil.example' },
      { origin: 'http://localhost:9999' },
      { origin: 'null' },
      { origin: 'not a url' },
    ];
    for (const extra of attempts) {
      const res = await request(`/api/v1/clips/${clipId}/move`, {
        method: 'POST',
        headers: { ...header, ...json, ...extra },
        body,
      });
      expect(res.status, JSON.stringify(extra)).toBe(403);
    }
    expect(locationOf(clipId)).toBe('loc1.shelf-1');
    const ok = await request(`/api/v1/clips/${clipId}/move`, {
      method: 'POST',
      headers: { ...header, ...json, origin: 'http://localhost:8787' },
      body,
    });
    expect(ok.status).toBe(200);
  });

  it('slows guessing: after repeated failures even the right token is refused for a while', async () => {
    const { request } = await setup({ rateLimits: { failedAuthPerMinute: 3 } });
    for (let i = 0; i < 3; i += 1) {
      expect(
        (await request('/api/v1/locations/tree', { headers: { authorization: 'Bearer nope' } }))
          .status,
      ).toBe(401);
    }
    const blocked = await request('/api/v1/locations/tree', { headers: bearer });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).not.toBeNull();
    // A session is not a guess at the token, so it is not caught by that limit.
  });
});

describe('GET /api/v1/tags/:tag', () => {
  it('describes a clip and a location, in either case', async () => {
    const { request, clipId } = await setup();
    const clip = await request(`/api/v1/tags/${CLIP_TAG}`, { headers: bearer });
    expect(clip.status).toBe(200);
    expect(await clip.json()).toEqual({
      kind: 'clip',
      clip: {
        id: clipId,
        state: 'on_spool',
        location_id: 'loc1.shelf-1',
        filament: { manufacturer: 'Acme', type: 'PLA', color: 'Red' },
      },
    });
    const shelf = await request(`/api/v1/tags/${SHELF_TAG.toLowerCase()}`, { headers: bearer });
    expect(await shelf.json()).toMatchObject({
      kind: 'location',
      location: { id: 'closet-storage.shelf-1', leaf: true, capacity_mode: 'soft' },
    });
  });

  it('gives the same 404 for a malformed, an unknown and another tenant’s tag', async () => {
    const { request, asTenant } = await setup();
    const bodies: string[] = [];
    for (const tag of ['short', 'ZZZZZZZZZZZZ', `${CLIP_TAG}A`, 'ABCDEFGHJKI2', '%00']) {
      const res = await request(`/api/v1/tags/${tag}`, { headers: bearer });
      expect(res.status, tag).toBe(404);
      bodies.push(await res.text());
    }
    // Tenant B holds no tag the way tenant A does: a tenant with nothing sees nothing.
    const { sql } = await setup();
    const empty = createApp({
      auth: {
        authenticate: () =>
          Promise.resolve({
            subject: 'c',
            tenantId: 'tenant-c',
            scopes: new Set([Scope.LocationsRead]),
          }),
      },
      data: (p) => createScopedData(sql, p),
      allowedHosts: ['localhost'],
    });
    const other = await request(`/api/v1/tags/${CLIP_TAG}`, { app: empty });
    expect(other.status).toBe(404);
    bodies.push(await other.text());
    expect(new Set(bodies).size).toBe(1);
    expect(asTenant).toBeDefined();
  });

  it('shows each tenant its own thing under the same tag ID', async () => {
    const { request, asTenant } = await setup();
    const b = await request(`/api/v1/tags/${CLIP_TAG}`, { app: asTenant(TENANT_B) });
    expect(await b.json()).toMatchObject({
      clip: { filament: { color: 'Blue' }, location_id: 'b-shelf' },
    });
    const a = await request(`/api/v1/tags/${CLIP_TAG}`, { headers: bearer });
    expect(await a.json()).toMatchObject({ clip: { filament: { color: 'Red' } } });
  });

  it('needs sign-in and the read scope, and is rate limited', async () => {
    const { request, asTenant } = await setup({ rateLimits: { resolverPerMinute: 2 } });
    expect((await request(`/api/v1/tags/${CLIP_TAG}`)).status).toBe(401);
    expect(
      (await request(`/api/v1/tags/${CLIP_TAG}`, { app: asTenant(TENANT_A, []) })).status,
    ).toBe(403);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1)
      statuses.push((await request(`/api/v1/tags/${CLIP_TAG}`, { headers: bearer })).status);
    expect(statuses).toEqual([200, 200, 429]);
  });
});

describe('GET /api/v1/locations/:id/clips', () => {
  it('lists the clips at a place, and 404s an unknown or another tenant’s place', async () => {
    const { request, clipId } = await setup();
    const res = await request('/api/v1/locations/loc1.shelf-1/clips', { headers: bearer });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { clips: { id: string }[] }).clips.map((c) => c.id)).toEqual([
      clipId,
    ]);
    expect((await request('/api/v1/locations/nowhere/clips', { headers: bearer })).status).toBe(
      404,
    );
    expect((await request('/api/v1/locations/b-shelf/clips', { headers: bearer })).status).toBe(
      404,
    );
    expect((await request('/api/v1/locations/BAD_ID/clips', { headers: bearer })).status).toBe(400);
  });
});

describe('POST /api/v1/clips/:id/move', () => {
  const move = (
    s: Awaited<ReturnType<typeof setup>>,
    id: string,
    body: unknown,
    headers: Record<string, string> = { ...bearer, ...json },
  ) =>
    s.request(`/api/v1/clips/${id}/move`, { method: 'POST', headers, body: JSON.stringify(body) });

  it('moves the clip and records one move event with where it came from', async () => {
    const s = await setup();
    const res = await move(s, s.clipId, { to: 'loc1.shelf-2' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      moved: true,
      clip: { id: s.clipId, location_id: 'loc1.shelf-2' },
      check: { outcome: 'ok', scope: 'leaf' },
    });
    expect(s.locationOf(s.clipId)).toBe('loc1.shelf-2');
    expect(s.events()).toEqual([
      expect.objectContaining({
        type: 'move',
        clip_id: s.clipId,
        from_location_id: 'loc1.shelf-1',
        to_location_id: 'loc1.shelf-2',
      }),
    ]);
  });

  it('does nothing, and records nothing, when the clip is already there', async () => {
    const s = await setup();
    const res = await move(s, s.clipId, { to: 'loc1.shelf-1' });
    expect(await res.json()).toMatchObject({ moved: false });
    expect(s.events()).toHaveLength(0);
  });

  it('asks before going past a hard limit, and goes through once confirmed', async () => {
    const s = await setup();
    s.fill('loc1.shelf-2', 16);
    const refused = await move(s, s.clipId, { to: 'loc1.shelf-2' });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: 'needs_confirmation',
      check: { outcome: 'warning', free_after: -1 },
    });
    expect(s.locationOf(s.clipId)).toBe('loc1.shelf-1');
    expect(s.events()).toHaveLength(0);
    const confirmed = await move(s, s.clipId, { to: 'loc1.shelf-2', confirm: true });
    expect(confirmed.status).toBe(200);
    expect(s.locationOf(s.clipId)).toBe('loc1.shelf-2');
    expect(s.events()).toHaveLength(1);
  });

  it('allows a soft limit and a place with no capacity set', async () => {
    const s = await setup();
    s.db.prepare("UPDATE location SET capacity = 1 WHERE id = 'closet-storage.shelf-1'").run();
    const first = await move(s, s.clipId, { to: 'closet-storage.shelf-1' });
    expect(await first.json()).toMatchObject({ check: { outcome: 'ok' } });
    const second = await move(s, s.clipId, { to: 'closet-storage.shelf-2' });
    expect(await second.json()).toMatchObject({
      moved: true,
      check: { outcome: 'capacity_not_set' },
    });
  });

  it('refuses a container, a slot, and an unknown clip or place', async () => {
    const s = await setup();
    const slot = (
      s.db
        .prepare("SELECT id FROM location WHERE tenant_id = ? AND type = 'active_use' LIMIT 1")
        .get(TENANT_A) as unknown as { id: string }
    ).id;
    const cases: [unknown, number, string][] = [
      [{ to: 'loc1' }, 422, 'not_a_leaf'],
      [{ to: slot }, 422, 'slot_not_supported'],
      [{ to: 'nowhere' }, 404, 'location_not_found'],
    ];
    for (const [body, status, error] of cases) {
      const res = await move(s, s.clipId, body);
      expect(res.status, error).toBe(status);
      expect(await res.json()).toEqual({ error });
    }
    const missing = await move(s, uuid(), { to: 'loc1.shelf-2' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });
    expect(s.events()).toHaveLength(0);
    expect(s.locationOf(s.clipId)).toBe('loc1.shelf-1');
  });

  it('will not take a clip out of a slot either (the load workflow does that)', async () => {
    const s = await setup();
    const slot = (
      s.db
        .prepare("SELECT id FROM location WHERE tenant_id = ? AND type = 'active_use' LIMIT 1")
        .get(TENANT_A) as unknown as { id: string }
    ).id;
    const inSlot = s.clip(TENANT_A, s.red, 'SKQT0000AAAA', slot);
    const res = await move(s, inSlot, { to: 'loc1.shelf-2' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'slot_not_supported' });
  });

  it('never touches another tenant: its clip and its places answer 404 and nothing changes', async () => {
    const s = await setup();
    const otherClip = await move(s, s.clipB, { to: 'loc1.shelf-2' });
    expect(otherClip.status).toBe(404);
    const otherPlace = await move(s, s.clipId, { to: 'b-shelf' });
    expect(otherPlace.status).toBe(404);
    expect(await otherPlace.json()).toEqual({ error: 'location_not_found' });
    expect(s.locationOf(s.clipId)).toBe('loc1.shelf-1');
    expect(s.locationOf(s.clipB)).toBe('b-shelf');
    expect(s.events()).toHaveLength(0);
  });

  it('validates the body strictly', async () => {
    const s = await setup();
    const url = `/api/v1/clips/${s.clipId}/move`;
    const send = (body: string, headers: Record<string, string> = { ...bearer, ...json }) =>
      s.request(url, { method: 'POST', headers, body });
    const bad: [string, Record<string, string>?][] = [
      ['{"to":"loc1.shelf-2"}', { ...bearer, 'content-type': 'text/plain' }],
      ['{"to":"loc1.shelf-2"}', bearer],
      ['not json'],
      ['[]'],
      ['null'],
      ['{}'],
      ['{"to":5}'],
      ['{"to":"BAD ID"}'],
      [`{"to":"${'a'.repeat(65)}"}`],
      ['{"to":"loc1.shelf-2","confirm":"yes"}'],
      ['{"to":"loc1.shelf-2","extra":1}'],
      ['{"to":"loc1.shelf-2","__proto__":{}}'],
      ['{"to":"loc1.shelf-2","pad":"\u00e9"}', { ...bearer, ...json, 'content-length': '99999' }],
      [`{"to":"loc1.shelf-2","pad":"${'x'.repeat(2000)}"}`],
    ];
    for (const [body, headers] of bad) {
      const res = await send(body, headers);
      expect(res.status, body.slice(0, 40)).toBe(400);
    }
    expect(
      (
        await s.request('/api/v1/clips/not-a-uuid/move', {
          method: 'POST',
          headers: { ...bearer, ...json },
          body: '{"to":"loc1.shelf-2"}',
        })
      ).status,
    ).toBe(400);
    expect(s.events()).toHaveLength(0);
  });

  it('needs the write scope', async () => {
    const s = await setup();
    const res = await move(s, s.clipId, { to: 'loc1.shelf-2' }, json);
    expect(res.status).toBe(401);
    const readOnly = await s.request(`/api/v1/clips/${s.clipId}/move`, {
      method: 'POST',
      app: s.asTenant(TENANT_A, [Scope.LocationsRead]),
      headers: json,
      body: '{"to":"loc1.shelf-2"}',
    });
    expect(readOnly.status).toBe(403);
    expect(s.locationOf(s.clipId)).toBe('loc1.shelf-1');
  });

  it('does not store a move when the clip or the room changed since it was checked', async () => {
    const s = await setup();
    // Another request fills the last place of a hard limit after this one checked: simulate by
    // racing the guard, filling the shelf between the check and the write.
    s.fill('loc1.shelf-2', 15);
    const data = createScopedData(
      s.sql,
      s.principalFor(TENANT_A, [Scope.LocationsRead, Scope.InventoryWrite]),
    );
    const realBatch = s.sql.batch.bind(s.sql);
    s.sql.batch = async (statements) => {
      s.fill('loc1.shelf-2', 1);
      await realBatch(statements);
    };
    const result = await data.moveClip(s.clipId, 'loc1.shelf-2', false);
    expect(result).toEqual({ ok: false, refusal: 'conflict' });
    expect(s.locationOf(s.clipId)).toBe('loc1.shelf-1');
    expect(s.events()).toHaveLength(0);

    // A clip that someone else already moved is not moved again from where it no longer is.
    s.sql.batch = async (statements) => {
      s.db
        .prepare("UPDATE clip SET location_id = 'closet-storage.shelf-1' WHERE id = ?")
        .run(s.clipId);
      await realBatch(statements);
    };
    const stale = await data.moveClip(s.clipId, 'loc1.shelf-2', true);
    expect(stale).toEqual({ ok: false, refusal: 'conflict' });
    expect(s.locationOf(s.clipId)).toBe('closet-storage.shelf-1');
    expect(s.events()).toHaveLength(0);
  });

  it('keeps the event log append-only: a second move adds a row and changes none', async () => {
    const s = await setup();
    await move(s, s.clipId, { to: 'loc1.shelf-2' });
    await move(s, s.clipId, { to: 'closet-storage.shelf-1' });
    expect(s.events().map((e) => [e.from_location_id, e.to_location_id])).toEqual([
      ['loc1.shelf-1', 'loc1.shelf-2'],
      ['loc1.shelf-2', 'closet-storage.shelf-1'],
    ]);
  });
});
