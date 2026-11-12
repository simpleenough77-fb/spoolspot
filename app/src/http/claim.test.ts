// SPDX-License-Identifier: AGPL-3.0-or-later
// Claiming an existing tag for a place (SPOOL-191 decision 4), over the real HTTP application.
import { describe, expect, it } from 'vitest';
import { createDevTokenProvider } from '../auth/dev-token.ts';
import { ForbiddenError, Scope, type Principal } from '../auth/principal.ts';
import { createMemorySessionStore } from '../auth/session.ts';
import { ClaimInvariantError } from '../data/claim.ts';
import { createScopedData } from '../data/scoped.ts';
import { DEMO_PLACE_TAGS } from '../seed/demo.ts';
import type { Sql, SqlParam, Statement } from '../db/sql.ts';
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
const SHELL = '<!doctype html><title>shell</title>';
const bearer = { authorization: `Bearer ${TEST_TOKEN}` };
const json = { 'content-type': 'application/json' };
/** Valid ADR-0001 IDs (Crockford base32, 12 characters). */
const TAG_1 = 'CA1MTAG00001';
const TAG_2 = 'CA1MTAG00002';
const TAG_3 = 'CA1MTAG00003';
const SHELF = 'loc1.shelf-1';
const OTHER_SHELF = 'loc1.shelf-2';
const CONTAINER = 'loc1';

async function setup(options: { rateLimits?: { resolverPerMinute?: number } } = {}) {
  const { sql, db } = memoryDatabase();
  await importSeed(sql, TENANT_A, readSeed(), readJson(SEED_SCHEMA_PATH));
  db.prepare('INSERT INTO tenant_settings (tenant_id) VALUES (?)').run(TENANT_B);
  await importSeed(sql, TENANT_B, readSeed(), readJson(SEED_SCHEMA_PATH));
  const principalFor = (tenantId: string, scopes: string[]): Principal => ({
    subject: tenantId,
    tenantId,
    scopes: new Set(scopes),
  });
  const app = createApp({
    auth: createDevTokenProvider({ token: TEST_TOKEN, tenantId: TENANT_A }),
    data: (p) => createScopedData(sql, p),
    allowedHosts: ['localhost'],
    sessions: createMemorySessionStore(),
    tagPages: { instanceCode: CODE, shell: SHELL },
    ...(options.rateLimits ? { rateLimits: options.rateLimits } : {}),
  });
  const asTenant = (
    tenantId: string,
    scopes: string[] = [Scope.LocationsRead, Scope.InventoryWrite],
  ) =>
    createApp({
      auth: { authenticate: () => Promise.resolve(principalFor(tenantId, scopes)) },
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
  const claim = (
    tag: string,
    body: unknown,
    init: { app?: ReturnType<typeof createApp>; headers?: Record<string, string> } = {},
  ) =>
    request(`/api/v1/tags/${tag}/claim`, {
      method: 'POST',
      headers: init.headers ?? { ...bearer, ...json },
      body: JSON.stringify(body),
      ...(init.app ? { app: init.app } : {}),
    });
  const registry = (tenant: string) =>
    db
      .prepare('SELECT tag_id, kind, target_id FROM tag WHERE tenant_id = ? ORDER BY tag_id')
      .all(tenant) as unknown as { tag_id: string; kind: string; target_id: string }[];
  const columnTag = (tenant: string, id: string) =>
    (
      db.prepare('SELECT tag_id FROM location WHERE tenant_id = ? AND id = ?').get(tenant, id) as {
        tag_id: string | null;
      }
    ).tag_id;
  const clipWithTag = (tenant: string, tag: string): void => {
    const f = uuid();
    db.prepare(
      "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, 'Acme', 'PLA', ?, 'disposable')",
    ).run(tenant, f, f);
    db.prepare(
      "INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, ?, ?, ?, ?, 'on_spool')",
    ).run(tenant, uuid(), tag, f, SHELF);
  };
  return { db, sql, app, asTenant, request, claim, registry, columnTag, clipWithTag };
}

describe('POST /api/v1/tags/:tag/claim (SPOOL-191)', () => {
  it('claims an existing tag for a leaf through the column, so the registry follows', async () => {
    const { claim, request, registry, columnTag } = await setup();
    const res = await claim(TAG_1.toLowerCase(), { location_id: SHELF });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tag_id: TAG_1,
      location_id: SHELF,
      replaced: false,
      changed: true,
    });
    expect(columnTag(TENANT_A, SHELF)).toBe(TAG_1);
    expect(registry(TENANT_A)).toEqual([{ tag_id: TAG_1, kind: 'location', target_id: SHELF }]);
    const view = await request(`/api/v1/tags/${TAG_1}`, { headers: bearer });
    expect(await view.json()).toMatchObject({ kind: 'location', location: { id: SHELF } });
    // Claiming the place's own tag again changes nothing.
    const again = await claim(TAG_1, { location_id: SHELF });
    expect(await again.json()).toMatchObject({ changed: false, replaced: false });
  });

  it('claims a tag for a container as a registry row only (decision 2)', async () => {
    const { claim, registry, columnTag } = await setup();
    const res = await claim(TAG_1, { location_id: CONTAINER });
    expect(res.status).toBe(200);
    expect(columnTag(TENANT_A, CONTAINER)).toBeNull();
    expect(registry(TENANT_A)).toEqual([{ tag_id: TAG_1, kind: 'location', target_id: CONTAINER }]);
    // Replacing a container's tag swaps the one registry row.
    expect((await claim(TAG_2, { location_id: CONTAINER })).status).toBe(409);
    const replaced = await claim(TAG_2, { location_id: CONTAINER, replace: true });
    expect(await replaced.json()).toMatchObject({ replaced: true, changed: true });
    expect(registry(TENANT_A)).toEqual([{ tag_id: TAG_2, kind: 'location', target_id: CONTAINER }]);
  });

  it('refuses a malformed tag ID or body, and other systems’ payloads, with one 400', async () => {
    const { claim, request, registry } = await setup();
    for (const tag of ['short', 'CA1MTAG0000I', 'CA1MTAG000011', `${CODE}${TAG_1}`]) {
      const res = await claim(encodeURIComponent(tag), { location_id: SHELF });
      expect(res.status, tag).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_request' });
    }
    for (const body of [
      {},
      { location_id: SHELF, replace: 'yes' },
      { location_id: SHELF, extra: 1 },
      { location_id: 'Not A Place' },
      { location_id: 'x'.repeat(65) },
      [SHELF],
    ]) {
      expect((await claim(TAG_1, body)).status, JSON.stringify(body)).toBe(400);
    }
    const wrongType = await request(`/api/v1/tags/${TAG_1}/claim`, {
      method: 'POST',
      headers: { ...bearer, 'content-type': 'text/plain' },
      body: JSON.stringify({ location_id: SHELF }),
    });
    expect(wrongType.status).toBe(400);
    expect(registry(TENANT_A)).toEqual([]);
  });

  it('refuses an ID already in use in this tenant without saying what it is on', async () => {
    const { claim, clipWithTag, registry } = await setup();
    clipWithTag(TENANT_A, TAG_1);
    expect((await claim(TAG_2, { location_id: OTHER_SHELF })).status).toBe(200);
    const bodies: string[] = [];
    for (const tag of [TAG_1, TAG_2]) {
      const res = await claim(tag, { location_id: SHELF });
      expect(res.status, tag).toBe(409);
      bodies.push(await res.text());
    }
    // A clip's tag and another place's tag are refused with the very same body.
    expect(bodies).toEqual([
      JSON.stringify({ error: 'tag_in_use' }),
      JSON.stringify({ error: 'tag_in_use' }),
    ]);
    expect(registry(TENANT_A).map((r) => r.tag_id)).toEqual([TAG_1, TAG_2]);
  });

  it('needs replace to change a place’s tag, and replacing is one atomic swap', async () => {
    const { claim, registry, columnTag } = await setup();
    expect((await claim(TAG_1, { location_id: SHELF })).status).toBe(200);
    const refused = await claim(TAG_2, { location_id: SHELF });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'location_has_tag' });
    expect(columnTag(TENANT_A, SHELF)).toBe(TAG_1);
    const res = await claim(TAG_2, { location_id: SHELF, replace: true });
    expect(await res.json()).toEqual({
      tag_id: TAG_2,
      location_id: SHELF,
      replaced: true,
      changed: true,
    });
    expect(columnTag(TENANT_A, SHELF)).toBe(TAG_2);
    // The old ID is released, the new one recorded, nothing else left behind.
    expect(registry(TENANT_A)).toEqual([{ tag_id: TAG_2, kind: 'location', target_id: SHELF }]);
    expect((await claim(TAG_1, { location_id: OTHER_SHELF })).status).toBe(200);
  });

  it('stores nothing when the place changed between the check and the write', async () => {
    const { sql, columnTag, registry } = await setup();
    const principal: Principal = {
      subject: 'x',
      tenantId: TENANT_A,
      scopes: new Set([Scope.LocationsRead, Scope.InventoryWrite]),
    };
    // A data layer whose first read is followed by a competing claim, before its own write.
    let raced = false;
    const racing = {
      all: async <T extends object>(q: string, p?: readonly (string | number | null)[]) => {
        const rows = await sql.all<T>(q, p);
        if (!raced && q.includes("kind = 'location' AND target_id")) {
          raced = true;
          await sql.batch([
            {
              query: 'UPDATE location SET tag_id = ? WHERE tenant_id = ? AND id = ?',
              params: [TAG_3, TENANT_A, SHELF],
            },
          ]);
        }
        return rows;
      },
      batch: sql.batch.bind(sql),
    };
    const data = createScopedData(racing, principal);
    expect(await data.claimTag(TAG_1, SHELF, true)).toEqual({ ok: false, refusal: 'conflict' });
    expect(columnTag(TENANT_A, SHELF)).toBe(TAG_3);
    expect(registry(TENANT_A)).toEqual([{ tag_id: TAG_3, kind: 'location', target_id: SHELF }]);
  });

  it('isolates tenants: the same ID elsewhere neither blocks nor shows; other places are 404', async () => {
    const { claim, asTenant, registry, request, db } = await setup();
    const b = asTenant(TENANT_B);
    // B claims the ID first; A can still claim it for its own place, and learns nothing about B's.
    expect((await claim(TAG_1, { location_id: SHELF }, { app: b })).status).toBe(200);
    const mine = await claim(TAG_1, { location_id: SHELF });
    expect(mine.status).toBe(200);
    expect(await mine.json()).toEqual({
      tag_id: TAG_1,
      location_id: SHELF,
      replaced: false,
      changed: true,
    });
    expect(registry(TENANT_A)).toEqual([{ tag_id: TAG_1, kind: 'location', target_id: SHELF }]);
    expect(registry(TENANT_B)).toEqual([{ tag_id: TAG_1, kind: 'location', target_id: SHELF }]);
    // A place that does not exist in the caller's tenant: one 404, the same as an unknown place.
    db.prepare(
      `INSERT INTO location (tenant_id, id, name, type, leaf, capacity, capacity_mode, tag_source)
       VALUES (?, 'b-only', 'B only', 'passive_storage', 1, 5, 'soft', 'sticker')`,
    ).run(TENANT_B);
    const bodies: string[] = [];
    for (const place of ['b-only', 'no-such-place']) {
      const res = await claim(TAG_2, { location_id: place });
      expect(res.status, place).toBe(404);
      bodies.push(await res.text());
    }
    expect(bodies).toEqual([
      JSON.stringify({ error: 'not_found' }),
      JSON.stringify({ error: 'not_found' }),
    ]);
    expect(registry(TENANT_B).map((r) => r.tag_id)).toEqual([TAG_1]);
    // After both claims, each tenant resolves the ID to its own place only.
    const view = await request(`/api/v1/tags/${TAG_1}`, { app: b });
    expect(await view.json()).toMatchObject({ location: { id: SHELF } });
  });

  it('needs the write scope and a signed-in caller; a cookie claim must come from this site', async () => {
    const { claim, asTenant, request, registry } = await setup();
    const readOnly = asTenant(TENANT_A, [Scope.LocationsRead]);
    expect((await claim(TAG_1, { location_id: SHELF }, { app: readOnly })).status).toBe(403);
    expect((await claim(TAG_1, { location_id: SHELF }, { headers: json })).status).toBe(401);
    const signIn = await request('/api/v1/session', { method: 'POST', headers: bearer });
    const cookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const crossSite = await claim(
      TAG_1,
      { location_id: SHELF },
      { headers: { cookie, ...json, origin: 'http://evil.example' } },
    );
    expect(crossSite.status).toBe(403);
    expect(registry(TENANT_A)).toEqual([]);
    const sameSite = await claim(
      TAG_1,
      { location_id: SHELF },
      { headers: { cookie, ...json, origin: 'http://localhost:8787' } },
    );
    expect(sameSite.status).toBe(200);
  });

  it('is rate limited like the tag lookup', async () => {
    const { claim } = await setup({ rateLimits: { resolverPerMinute: 2 } });
    expect((await claim(TAG_1, { location_id: SHELF })).status).toBe(200);
    expect((await claim(TAG_1, { location_id: SHELF })).status).toBe(200);
    const limited = await claim(TAG_1, { location_id: SHELF });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
  });

  it('keeps the unauthenticated answer for an unknown tag byte-identical before and after a claim', async () => {
    const { claim, request } = await setup();
    const snapshot = async (tag: string) => {
      const out: string[] = [];
      for (const path of [`/${CODE}${tag}`, `/${CODE.toLowerCase()}${tag.toLowerCase()}`]) {
        const res = await request(path);
        out.push(`${String(res.status)} ${JSON.stringify([...res.headers])} ${await res.text()}`);
      }
      for (const path of [`/api/v1/tags/${tag}`]) {
        const res = await request(path);
        out.push(`${String(res.status)} ${JSON.stringify([...res.headers])} ${await res.text()}`);
      }
      const head = await request(`/${CODE}${tag}`, { method: 'HEAD' });
      out.push(`${String(head.status)} ${JSON.stringify([...head.headers])} ${await head.text()}`);
      const unsigned = await claim(tag, { location_id: SHELF }, { headers: json });
      out.push(
        `${String(unsigned.status)} ${JSON.stringify([...unsigned.headers])} ${await unsigned.text()}`,
      );
      return out;
    };
    const unknownBefore = await snapshot(TAG_1);
    const otherBefore = await snapshot(TAG_2);
    // A person signs in and claims TAG_1.
    const signIn = await request('/api/v1/session', { method: 'POST', headers: bearer });
    expect(signIn.status).toBe(204);
    expect((await claim(TAG_1, { location_id: SHELF })).status).toBe(200);
    // Without signing in, the claimed tag and a still-unknown tag answer exactly as before.
    expect(await snapshot(TAG_1)).toEqual(unknownBefore);
    expect(await snapshot(TAG_2)).toEqual(otherBefore);
    expect(unknownBefore).toEqual(otherBefore);
  });

  it('tells a signed-in caller an unclaimed tag is not found in their tenant only', async () => {
    const { claim, asTenant, request } = await setup();
    const b = asTenant(TENANT_B);
    expect((await claim(TAG_1, { location_id: SHELF }, { app: b })).status).toBe(200);
    // For A the ID is unclaimed: the same 404 as any unknown tag, never B's place.
    const res = await request(`/api/v1/tags/${TAG_1}`, { headers: bearer });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(JSON.stringify({ error: 'not_found' }));
  });

  it('refuses the reserved demo tag IDs exactly like an invalid ID', async () => {
    const { claim, registry } = await setup();
    const invalid = await claim('short', { location_id: SHELF });
    const expected = `${String(invalid.status)} ${await invalid.text()}`;
    for (const tag of [
      DEMO_PLACE_TAGS[0]?.[1] ?? '',
      'DEM1ZZZZZZZZ',
      'DEM000000001',
      'dem0abcdefgh',
    ]) {
      const res = await claim(tag, { location_id: SHELF });
      expect(`${String(res.status)} ${await res.text()}`, tag).toBe(expected);
    }
    expect(registry(TENANT_A)).toEqual([]);
  });
});

/** A Sql that records how each batch ended and can rewrite statements, to force races and faults. */
function instrumented(sql: Sql, rewrite: (s: Statement) => Statement = (s) => s) {
  const outcomes: ('ok' | 'rejected')[] = [];
  const wrapped: Sql = {
    all: <T extends object>(q: string, p?: readonly SqlParam[]) => sql.all<T>(q, p),
    batch: async (statements) => {
      try {
        const result = await sql.batch(statements.map(rewrite));
        outcomes.push('ok');
        return result;
      } catch (error) {
        outcomes.push('rejected');
        throw error;
      }
    },
  };
  return { wrapped, outcomes };
}

const writer = (tenantId: string): Principal => ({
  subject: tenantId,
  tenantId,
  scopes: new Set([Scope.LocationsRead, Scope.InventoryWrite]),
});

describe('claimTag review round 1 (SPOOL-191)', () => {
  it("replacing a container's tag never touches another tenant's container with the same tag", async () => {
    const { claim, asTenant, registry } = await setup();
    expect((await claim(TAG_1, { location_id: CONTAINER })).status).toBe(200);
    expect(
      (await claim(TAG_1, { location_id: CONTAINER }, { app: asTenant(TENANT_B) })).status,
    ).toBe(200);
    const res = await claim(TAG_2, { location_id: CONTAINER, replace: true });
    expect(res.status).toBe(200);
    expect(registry(TENANT_A)).toEqual([{ tag_id: TAG_2, kind: 'location', target_id: CONTAINER }]);
    expect(registry(TENANT_B)).toEqual([{ tag_id: TAG_1, kind: 'location', target_id: CONTAINER }]);
  });

  it('rolls the whole write back when it would change more than one row', async () => {
    const { sql, registry, claim, asTenant } = await setup();
    expect((await claim(TAG_1, { location_id: CONTAINER })).status).toBe(200);
    expect(
      (await claim(TAG_1, { location_id: CONTAINER }, { app: asTenant(TENANT_B) })).status,
    ).toBe(200);
    // Force a write that matches both tenants' rows by dropping its tenant condition.
    const { wrapped } = instrumented(sql, (st) =>
      st.query.includes('UPDATE tag SET tag_id = ?')
        ? {
            query: st.query.replace('WHERE tenant_id = ? AND kind', 'WHERE kind'),
            params: [st.params?.[0] ?? null, ...(st.params ?? []).slice(2)],
          }
        : st,
    );
    await expect(
      createScopedData(wrapped, writer(TENANT_A)).claimTag(TAG_2, CONTAINER, true),
    ).rejects.toBeInstanceOf(ClaimInvariantError);
    expect(registry(TENANT_A)).toEqual([{ tag_id: TAG_1, kind: 'location', target_id: CONTAINER }]);
    expect(registry(TENANT_B)).toEqual([{ tag_id: TAG_1, kind: 'location', target_id: CONTAINER }]);
  });

  it('two claims racing for an untagged container: one wins, the other is a conflict, no error', async () => {
    const { sql, registry } = await setup();
    const { wrapped, outcomes } = instrumented(sql);
    const data = () => createScopedData(wrapped, writer(TENANT_A));
    const results = await Promise.all([
      data().claimTag(TAG_1, CONTAINER, false),
      data().claimTag(TAG_2, CONTAINER, false),
    ]);
    expect(results.map((r) => (r.ok ? 'ok' : r.refusal))).toEqual(['ok', 'conflict']);
    expect(registry(TENANT_A)).toEqual([{ tag_id: TAG_1, kind: 'location', target_id: CONTAINER }]);
    // The guarded insert stored nothing and raised nothing.
    expect(outcomes).toEqual(['ok', 'ok']);
  });

  it("answers conflict, not an error, when the registry's one-tag-per-record index refuses the write", async () => {
    const { sql, registry, db } = await setup();
    // Without the statement's own guard, the unique index on (tenant, kind, target) is what refuses it.
    const { wrapped, outcomes } = instrumented(sql, (st) => ({
      ...st,
      query: st.query.replace(
        /AND NOT EXISTS \(SELECT 1 FROM tag t[\s\S]*?t\.target_id = l\.id\)/,
        '',
      ),
    }));
    db.prepare(
      "INSERT INTO tag (tenant_id, tag_id, kind, target_id) VALUES (?, ?, 'location', ?)",
    ).run(TENANT_A, TAG_3, CONTAINER);
    // The read happens before the competing row exists, as in a race.
    const racing: Sql = {
      all: async <T extends object>(q: string, p?: readonly SqlParam[]) => {
        const rows = await sql.all<T>(q, p);
        return q.includes("kind = 'location' AND target_id") ? [] : rows;
      },
      batch: (statements) => wrapped.batch(statements),
    };
    const result = await createScopedData(racing, writer(TENANT_A)).claimTag(
      TAG_1,
      CONTAINER,
      false,
    );
    expect(result).toEqual({ ok: false, refusal: 'conflict' });
    expect(outcomes).toEqual(['rejected']);
    expect(registry(TENANT_A)).toEqual([{ tag_id: TAG_3, kind: 'location', target_id: CONTAINER }]);
  });

  it("two replaces racing on a container's tag: one wins, the other is a conflict", async () => {
    const { sql, registry, claim } = await setup();
    expect((await claim(TAG_1, { location_id: CONTAINER })).status).toBe(200);
    const data = () => createScopedData(sql, writer(TENANT_A));
    const results = await Promise.all([
      data().claimTag(TAG_2, CONTAINER, true),
      data().claimTag(TAG_3, CONTAINER, true),
    ]);
    expect(results.map((r) => (r.ok ? 'ok' : r.refusal))).toEqual(['ok', 'conflict']);
    expect(registry(TENANT_A)).toEqual([{ tag_id: TAG_2, kind: 'location', target_id: CONTAINER }]);
  });

  it('the same ID claimed onto two leaves at once: the write itself refuses the loser as in use', async () => {
    const { sql, registry, columnTag } = await setup();
    // Deterministic race: another request claims TAG_1 for the other shelf right after this request's
    // in-use check has found it free, so only the write (the registry's unique index) can stop it.
    // Every read is also delayed, so the outcome does not depend on how calls are scheduled.
    let raced = false;
    const { wrapped, outcomes } = instrumented(sql);
    const racing: Sql = {
      all: async <T extends object>(q: string, p?: readonly SqlParam[]) => {
        await new Promise((resolve) => setTimeout(resolve, 1 + (q.length % 3)));
        const rows = await sql.all<T>(q, p);
        if (!raced && q.includes('SELECT 1 AS one FROM tag')) {
          raced = true;
          await sql.batch([
            {
              query: 'UPDATE location SET tag_id = ? WHERE tenant_id = ? AND id = ?',
              params: [TAG_1, TENANT_A, OTHER_SHELF],
            },
          ]);
        }
        return rows;
      },
      batch: (statements) => wrapped.batch(statements),
    };
    const result = await createScopedData(racing, writer(TENANT_A)).claimTag(TAG_1, SHELF, false);
    expect(raced).toBe(true);
    expect(outcomes).toEqual(['rejected']);
    expect(result).toEqual({ ok: false, refusal: 'tag_in_use' });
    expect(columnTag(TENANT_A, SHELF)).toBeNull();
    expect(registry(TENANT_A)).toEqual([
      { tag_id: TAG_1, kind: 'location', target_id: OTHER_SHELF },
    ]);
  });

  it('the data layer itself refuses a caller without the write scope', async () => {
    const { sql, registry } = await setup();
    const readOnly: Principal = {
      subject: 'r',
      tenantId: TENANT_A,
      scopes: new Set([Scope.LocationsRead]),
    };
    await expect(
      createScopedData(sql, readOnly).claimTag(TAG_1, SHELF, false),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(registry(TENANT_A)).toEqual([]);
  });
});
