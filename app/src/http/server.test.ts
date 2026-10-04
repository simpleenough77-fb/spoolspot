// SPDX-License-Identifier: AGPL-3.0-or-later
// Real HTTP server on an ephemeral loopback port: static files, content types, path traversal.
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevTokenProvider } from '../auth/dev-token.ts';
import { createScopedData } from '../data/scoped.ts';
import { importSeed } from '../seed/import.ts';
import {
  memoryDatabase,
  readJson,
  readSeed,
  SEED_SCHEMA_PATH,
  TENANT_A,
  TEST_TOKEN,
} from '../testing.ts';
import { createApp } from './app.ts';

let base = '';
let close: () => void = () => undefined;

beforeAll(async () => {
  const { sql } = memoryDatabase();
  await importSeed(sql, TENANT_A, readSeed(), readJson(SEED_SCHEMA_PATH));
  const app = createApp({
    auth: createDevTokenProvider({ token: TEST_TOKEN, tenantId: TENANT_A }),
    data: (principal) => createScopedData(sql, principal),
    allowedHosts: ['127.0.0.1'],
    staticHandler: serveStatic({ root: './app/public' }),
  });
  await new Promise<void>((resolve) => {
    const server = serve(
      { fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
      (info: AddressInfo) => {
        base = `http://127.0.0.1:${String(info.port)}`;
        resolve();
      },
    );
    close = () => server.close();
  });
});

afterAll(() => {
  close();
});

describe('real server', () => {
  it('serves the page with security headers', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await res.text()).toContain('Locations by type');
  });

  it('serves the script and stylesheet with usable content types', async () => {
    const js = await fetch(`${base}/summary.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    const css = await fetch(`${base}/app.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
  });

  it('answers the API with the token', async () => {
    const res = await fetch(`${base}/api/v1/locations/summary`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { total: number }).total).toBe(81);
  });

  it('refuses a wrong Host header over the wire', async () => {
    // fetch() will not let a caller override Host, so use node:http.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/`, { headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(421);
  });

  it.each([
    '/../package.json',
    '/%2e%2e/package.json',
    '/..%2fpackage.json',
    '/%2e%2e%2fpackage.json',
  ])('does not serve files outside the public directory (%s)', async (path) => {
    const res = await fetch(`${base}${path}`);
    expect(await res.text()).not.toContain('"name": "spoolspot"');
  });
});
