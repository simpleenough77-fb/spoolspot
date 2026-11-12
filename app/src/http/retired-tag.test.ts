// SPDX-License-Identifier: AGPL-3.0-or-later
// SPOOL-201 over the real HTTP application: a retired tag ID looks exactly like an unknown or another
// tenant's ID on the lookup, and exactly like an ID in use on a claim.
import { describe, expect, it } from 'vitest';
import { createDevTokenProvider } from '../auth/dev-token.ts';
import { Scope, type Principal } from '../auth/principal.ts';
import { createMemorySessionStore } from '../auth/session.ts';
import { createScopedData } from '../data/scoped.ts';
import type { Sql } from '../db/sql.ts';
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
const OLD = 'RET1RETAG001';
const NEW = 'RET1RETAG002';
const UNKNOWN = 'RET1RETAG003';
const B_ONLY = 'RET1RETAG004';
const CLIP_TAG = 'RET1RETAG005';
const BOX_OLD = 'RET1RETAG006';
const BOX_NEW = 'RET1RETAG007';
const FRESH = 'RET1RETAG008';
const SHELF = 'loc1.shelf-1';
const OTHER_SHELF = 'loc1.shelf-2';
const CONTAINER = 'loc1';
const limits = { resolverPerMinute: 10_000, failedAuthPerMinute: 10_000 };

const writer = (tenantId: string): Principal => ({
  subject: tenantId,
  tenantId,
  scopes: new Set([Scope.LocationsRead, Scope.InventoryWrite]),
});

async function setup() {
  const { sql, db } = memoryDatabase();
  await importSeed(sql, TENANT_A, readSeed(), readJson(SEED_SCHEMA_PATH));
  db.prepare('INSERT INTO tenant_settings (tenant_id) VALUES (?)').run(TENANT_B);
  await importSeed(sql, TENANT_B, readSeed(), readJson(SEED_SCHEMA_PATH));
  const app = createApp({
    auth: createDevTokenProvider({ token: TEST_TOKEN, tenantId: TENANT_A }),
    data: (p) => createScopedData(sql, p),
    allowedHosts: ['localhost'],
    sessions: createMemorySessionStore(),
    tagPages: { instanceCode: CODE, shell: SHELL },
    rateLimits: limits,
  });
  const asTenant = (tenantId: string) =>
    createApp({
      auth: { authenticate: () => Promise.resolve(writer(tenantId)) },
      data: (p) => createScopedData(sql, p),
      allowedHosts: ['localhost'],
      rateLimits: limits,
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
  const claim = (tag: string, body: unknown, target?: ReturnType<typeof createApp>) =>
    request(`/api/v1/tags/${tag}/claim`, {
      method: 'POST',
      headers: { ...bearer, ...json },
      body: JSON.stringify(body),
      ...(target ? { app: target } : {}),
    });
  const retired = (tenant: string) =>
    (
      db
        .prepare('SELECT tag_id FROM tag_retired WHERE tenant_id = ? ORDER BY tag_id')
        .all(tenant) as {
        tag_id: string;
      }[]
    ).map((r) => r.tag_id);
  const clipWithTag = (tenant: string, tag: string): void => {
    const f = uuid();
    db.prepare(
      "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, 'Acme', 'PLA', ?, 'disposable')",
    ).run(tenant, f, f);
    db.prepare(
      "INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, ?, ?, ?, ?, 'on_spool')",
    ).run(tenant, uuid(), tag, f, SHELF);
  };
  /** OLD retired in A by a replace on a leaf, BOX_OLD by a replace on a container; B has B_ONLY. */
  const retireSome = async () => {
    expect((await claim(OLD, { location_id: SHELF })).status).toBe(200);
    expect((await claim(NEW, { location_id: SHELF, replace: true })).status).toBe(200);
    expect((await claim(BOX_OLD, { location_id: CONTAINER })).status).toBe(200);
    expect((await claim(BOX_NEW, { location_id: CONTAINER, replace: true })).status).toBe(200);
    expect((await claim(B_ONLY, { location_id: SHELF }, asTenant(TENANT_B))).status).toBe(200);
    expect(retired(TENANT_A)).toEqual([OLD, BOX_OLD]);
  };
  return { db, sql, app, asTenant, request, claim, retired, clipWithTag, retireSome };
}

/** Status, every header and the body, as one comparable string. */
async function full(res: Response): Promise<string> {
  return `${String(res.status)} ${JSON.stringify([...res.headers])} ${await res.text()}`;
}

describe('GET /api/v1/tags/:tag: a retired ID is indistinguishable (SPOOL-201)', () => {
  it('answers byte-identically for retired, unknown and other-tenant IDs, signed in or not', async () => {
    const { request, retireSome } = await setup();
    await retireSome();
    const answers = async (tag: string) => {
      const out: string[] = [];
      out.push(await full(await request(`/api/v1/tags/${tag}`, { headers: bearer })));
      out.push(await full(await request(`/api/v1/tags/${tag.toLowerCase()}`, { headers: bearer })));
      out.push(await full(await request(`/api/v1/tags/${tag}`)));
      out.push(await full(await request(`/${CODE}${tag}`)));
      out.push(await full(await request(`/${CODE}${tag}`, { method: 'HEAD' })));
      return out;
    };
    const unknown = await answers(UNKNOWN);
    // The signed-in answer is the plain 404 of any unknown tag.
    expect(unknown[0]).toMatch(/^404 /);
    expect(unknown[0]?.endsWith(JSON.stringify({ error: 'not_found' }))).toBe(true);
    for (const tag of [OLD, BOX_OLD, B_ONLY]) {
      expect(await answers(tag), tag).toEqual(unknown);
    }
  });

  it("another tenant sees its own use of an ID that A retired, and A's retirement is invisible to it", async () => {
    const { request, asTenant, claim, retireSome } = await setup();
    await retireSome();
    const b = asTenant(TENANT_B);
    const before = await full(await request(`/api/v1/tags/${OLD}`, { app: b }));
    expect(before).toBe(await full(await request(`/api/v1/tags/${UNKNOWN}`, { app: b })));
    // B can claim the ID A retired, and resolves it to its own place.
    expect((await claim(OLD, { location_id: OTHER_SHELF }, b)).status).toBe(200);
    const view = await request(`/api/v1/tags/${OLD}`, { app: b });
    expect(await view.json()).toMatchObject({ kind: 'location', location: { id: OTHER_SHELF } });
  });
});

describe('POST /api/v1/tags/:tag/claim: a retired ID answers exactly like one in use (SPOOL-201)', () => {
  it('refuses a retired ID for a leaf or a container, with or without replace, with the in-use answer', async () => {
    const { claim, clipWithTag, retireSome, db } = await setup();
    await retireSome();
    clipWithTag(TENANT_A, CLIP_TAG);
    db.prepare(
      "INSERT INTO location (tenant_id, id, name, type, leaf) VALUES (?, 'spare-box', 'Spare box', 'container', 0)",
    ).run(TENANT_A);
    const inUse = await full(await claim(CLIP_TAG, { location_id: OTHER_SHELF }));
    expect(inUse).toMatch(/^409 /);
    expect(inUse.endsWith(JSON.stringify({ error: 'tag_in_use' }))).toBe(true);
    // Another place's tag gives the same answer.
    expect(await full(await claim(NEW, { location_id: OTHER_SHELF }))).toBe(inUse);
    for (const tag of [OLD, BOX_OLD, OLD.toLowerCase()]) {
      for (const place of [OTHER_SHELF, 'spare-box', SHELF, CONTAINER]) {
        for (const replace of [false, true]) {
          expect(
            await full(await claim(tag, { location_id: place, replace })),
            `${tag} ${place}`,
          ).toBe(inUse);
        }
      }
    }
  });

  it('keeps today’s answers: re-claiming the current tag is unchanged; a replaced place takes a new tag', async () => {
    const { claim, retireSome } = await setup();
    await retireSome();
    for (const [tag, place] of [
      [NEW, SHELF],
      [BOX_NEW, CONTAINER],
    ] as const) {
      const again = await claim(tag, { location_id: place });
      expect(await again.json()).toEqual({
        tag_id: tag,
        location_id: place,
        replaced: false,
        changed: false,
      });
    }
    // The place whose tag was replaced can take yet another fresh tag.
    const fresh = await claim(FRESH, { location_id: SHELF, replace: true });
    expect(await fresh.json()).toEqual({
      tag_id: FRESH,
      location_id: SHELF,
      replaced: true,
      changed: true,
    });
  });

  it('a retirement between the check and the write is refused by the database and answered as in use', async () => {
    const { sql, retired } = await setup();
    /** A data layer whose retired-ID check is followed by a competing write that retires `tag`. */
    const racing = (tag: string) => {
      let raced = false;
      const wrapped: Sql = {
        all: async <T extends object>(q: string, p?: Parameters<Sql['all']>[1]) => {
          const rows = await sql.all<T>(q, p);
          if (!raced && q.includes('FROM tag_retired')) {
            raced = true;
            await sql.batch([
              {
                query: 'UPDATE location SET tag_id = ? WHERE tenant_id = ? AND id = ?',
                params: [tag, TENANT_A, OTHER_SHELF],
              },
              {
                query: 'UPDATE location SET tag_id = NULL WHERE tenant_id = ? AND id = ?',
                params: [TENANT_A, OTHER_SHELF],
              },
            ]);
          }
          return rows;
        },
        batch: sql.batch.bind(sql),
      };
      return createScopedData(wrapped, writer(TENANT_A));
    };
    // The leaf path (UPDATE location) and the container path (registry INSERT).
    for (const [tag, place] of [
      [FRESH, SHELF],
      ['RET1RETAG010', CONTAINER],
    ] as const) {
      expect(await racing(tag).claimTag(tag, place, false), place).toEqual({
        ok: false,
        refusal: 'tag_in_use',
      });
      expect(retired(TENANT_A)).toContain(tag);
    }
  });

  it('a retired ID in A never blocks a claim in B, and B retiring an ID never blocks A', async () => {
    const { claim, asTenant, retireSome } = await setup();
    await retireSome();
    const b = asTenant(TENANT_B);
    expect((await claim(OLD, { location_id: SHELF, replace: true }, b)).status).toBe(200);
    // B's replace retired B_ONLY in B only; A may claim it.
    expect((await claim(B_ONLY, { location_id: OTHER_SHELF })).status).toBe(200);
    expect((await claim(B_ONLY, { location_id: OTHER_SHELF }, b)).status).toBe(409);
  });
});
