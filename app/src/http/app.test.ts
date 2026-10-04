// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDevTokenProvider } from '../auth/dev-token.ts';
import { Scope, type AuthProvider, type Principal } from '../auth/principal.ts';
import { createScopedData, type ScopedData } from '../data/scoped.ts';
import { importSeed } from '../seed/import.ts';
import {
  memoryDatabase,
  readJson,
  readSeed,
  SEED_SCHEMA_PATH,
  TENANT_A,
  TENANT_B,
  TEST_TOKEN,
} from '../testing.ts';
import { createApp, CONTENT_SECURITY_POLICY, hostName } from './app.ts';

const HOSTS = ['localhost', '127.0.0.1', '[::1]'];

async function setup() {
  const { sql, db } = memoryDatabase();
  await importSeed(sql, TENANT_A, readSeed(), readJson(SEED_SCHEMA_PATH));
  db.prepare('INSERT INTO tenant_settings (tenant_id) VALUES (?)').run(TENANT_B);
  const auth = createDevTokenProvider({ token: TEST_TOKEN, tenantId: TENANT_A });
  const app = createApp({
    auth,
    data: (principal) => createScopedData(sql, principal),
    allowedHosts: HOSTS,
  });
  return { app, sql };
}

const get = (
  app: Awaited<ReturnType<typeof setup>>['app'],
  path: string,
  headers: Record<string, string> = {},
) => app.request(`http://localhost${path}`, { headers: { host: 'localhost:8787', ...headers } });

const bearer = { authorization: `Bearer ${TEST_TOKEN}` };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('hostName', () => {
  it.each([
    ['localhost:8787', 'localhost'],
    ['LOCALHOST', 'localhost'],
    ['[::1]:8787', '[::1]'],
    ['127.0.0.1', '127.0.0.1'],
  ])('parses %s', (input, expected) => {
    expect(hostName(input)).toBe(expected);
  });

  it.each(['', 'evil.com/x', 'a b', 'host:port', 'a@b'])('rejects %j', (input) => {
    expect(hostName(input)).toBeNull();
  });

  it('treats a missing header as no host', () => {
    expect(hostName(undefined)).toBeNull();
  });
});

describe('authentication', () => {
  it('answers 401 with an identical body for a missing and a wrong token', async () => {
    const { app } = await setup();
    const missing = await get(app, '/api/v1/locations/summary');
    const wrong = await get(app, '/api/v1/locations/summary', {
      authorization: `Bearer ${TEST_TOKEN}x`,
    });
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await missing.text()).toBe(await wrong.text());
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('answers 401, not 404, for unknown API paths without a token', async () => {
    const { app } = await setup();
    expect((await get(app, '/api/v1/nothing-here')).status).toBe(401);
  });

  it('answers 404 JSON for unknown API paths with a token', async () => {
    const { app } = await setup();
    const res = await get(app, '/api/v1/nothing-here', bearer);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});

describe('GET /api/v1/locations/summary', () => {
  it('returns the seed counts for the right token', async () => {
    const { app } = await setup();
    const res = await get(app, '/api/v1/locations/summary', bearer);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(81);
  });

  it('answers 403 when the principal lacks the scope', async () => {
    const { sql } = await setup();
    const auth: AuthProvider = {
      authenticate: () =>
        Promise.resolve({ subject: 'x', tenantId: TENANT_A, scopes: new Set<string>() }),
    };
    const app = createApp({
      auth,
      data: (p) => createScopedData(sql, p),
      allowedHosts: HOSTS,
    });
    const res = await get(app, '/api/v1/locations/summary');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it('never shows one tenant the data of another', async () => {
    const { sql } = await setup();
    const asTenant = (tenantId: string): Principal => ({
      subject: tenantId,
      tenantId,
      scopes: new Set([Scope.LocationsRead]),
    });
    const appFor = (tenantId: string) =>
      createApp({
        auth: { authenticate: () => Promise.resolve(asTenant(tenantId)) },
        data: (p) => createScopedData(sql, p),
        allowedHosts: HOSTS,
      });
    const a = (await (await get(appFor(TENANT_A), '/api/v1/locations/summary')).json()) as {
      total: number;
    };
    const b = (await (await get(appFor(TENANT_B), '/api/v1/locations/summary')).json()) as {
      total: number;
    };
    expect(a.total).toBe(81);
    expect(b.total).toBe(0);
  });
});

describe('host guard (DNS rebinding)', () => {
  it('refuses an unexpected Host header with an empty 421', async () => {
    const { app } = await setup();
    const res = await get(app, '/api/v1/locations/summary', { ...bearer, host: 'evil.example' });
    expect(res.status).toBe(421);
    expect(await res.text()).toBe('');
  });

  it('refuses before authentication, so a wrong host never reaches the token check', async () => {
    const authenticate = vi.fn<AuthProvider['authenticate']>(() => Promise.resolve(null));
    const app = createApp({
      auth: { authenticate },
      data: () => ({}) as ScopedData,
      allowedHosts: HOSTS,
    });
    await get(app, '/api/v1/locations/summary', { host: 'evil.example' });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('accepts the IPv6 loopback literal with a port', async () => {
    const { app } = await setup();
    const res = await get(app, '/api/v1/locations/summary', { ...bearer, host: '[::1]:8787' });
    expect(res.status).toBe(200);
  });
});

describe('security headers', () => {
  it.each([
    ['200', '/api/v1/locations/summary', bearer, 200],
    ['401', '/api/v1/locations/summary', {}, 401],
    ['421', '/api/v1/locations/summary', { host: 'evil.example' }, 421],
  ])('are present on a %s response', async (_label, path, headers, status) => {
    const { app } = await setup();
    const res = await get(app, path, headers);
    expect(res.status).toBe(status);
    expect(res.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('has a policy with no inline script or style allowance and no framing', () => {
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-inline');
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval');
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
  });
});

describe('failure handling', () => {
  it('returns a generic 500 and logs only the error name', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = createApp({
      auth: createDevTokenProvider({ token: TEST_TOKEN, tenantId: TENANT_A }),
      data: () => ({
        locationSummary: () => Promise.reject(new TypeError('secret detail 12345')),
      }),
      allowedHosts: HOSTS,
    });
    const res = await get(app, '/api/v1/locations/summary', bearer);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toBe('request failed: TypeError');
  });

  it('never writes the token to the console', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { app } = await setup();
    await get(app, '/api/v1/locations/summary', bearer);
    await get(app, '/api/v1/locations/summary', { authorization: `Bearer ${TEST_TOKEN}x` });
    const written = JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls]);
    expect(written).not.toContain(TEST_TOKEN);
  });
});
