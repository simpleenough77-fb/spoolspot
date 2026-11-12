// SPDX-License-Identifier: AGPL-3.0-or-later
// SPOOL-63: the stock endpoints over the real HTTP application.
import { describe, expect, it } from 'vitest';
import { createDevTokenProvider } from '../auth/dev-token.ts';
import { Scope } from '../auth/principal.ts';
import { createScopedData } from '../data/scoped.ts';
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
  uuid,
} from '../testing.ts';
import { createApp } from './app.ts';

const bearer = { authorization: `Bearer ${TEST_TOKEN}` };
const json = { 'content-type': 'application/json' };
const SHELF = 'closet-storage.shelf-1';

async function setup() {
  const { sql, db } = memoryDatabase();
  await importSeed(sql, TENANT_A, readSeed(), readJson(SEED_SCHEMA_PATH));
  await importSeed(sql, TENANT_B, readSeed(), readJson(SEED_SCHEMA_PATH));
  const add = (tenant: string, color: string, kind: string): string => {
    const id = uuid();
    db.prepare(
      "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, 'Acme', 'PLA', ?, ?)",
    ).run(tenant, id, color, kind);
    return id;
  };
  const red = add(TENANT_A, 'Red', 'disposable');
  const blue = add(TENANT_A, 'Blue', 'refillable');
  const green = add(TENANT_B, 'Green', 'refillable');
  const app = createApp({
    auth: createDevTokenProvider({ token: TEST_TOKEN, tenantId: TENANT_A }),
    data: (p) => createScopedData(sql, p),
    allowedHosts: ['localhost'],
  });
  const as = (tenantId: string, scopes: string[]) =>
    createApp({
      auth: {
        authenticate: () => Promise.resolve({ subject: 's', tenantId, scopes: new Set(scopes) }),
      },
      data: (p) => createScopedData(sql, p),
      allowedHosts: ['localhost'],
    });
  const call = (a: typeof app, path: string, init: RequestInit = {}) =>
    a.request(`http://localhost${path}`, {
      ...init,
      headers: {
        host: 'localhost',
        ...bearer,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  const post = (a: typeof app, body: unknown, headers: Record<string, string> = json) =>
    call(a, '/api/v1/stock/adjust', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { app, as, call, post, db, red, blue, green };
}

const tap = (filament_id: string, location_id = SHELF, pack = 'spool', delta = 1, extra = {}) => ({
  filament_id,
  location_id,
  pack,
  delta,
  ...extra,
});

describe('GET /api/v1/filaments and stock lists', () => {
  it('lists the catalog and the stock, and needs a sign-in', async () => {
    const { app, call, post, red } = await setup();
    expect(
      (await app.request('http://localhost/api/v1/filaments', { headers: { host: 'localhost' } }))
        .status,
    ).toBe(401);
    const list = (await (await call(app, '/api/v1/filaments')).json()) as {
      filaments: { color: string }[];
    };
    expect(list.filaments.map((f) => f.color)).toEqual(['Blue', 'Red']);
    await post(app, tap(red));
    const at = (await (await call(app, `/api/v1/locations/${SHELF}/stock`)).json()) as {
      lines: { count: number }[];
    };
    expect(at.lines).toMatchObject([{ count: 1 }]);
    const of = (await (await call(app, `/api/v1/filaments/${red}/stock`)).json()) as {
      lines: { location_id: string }[];
    };
    expect(of.lines).toMatchObject([{ location_id: SHELF }]);
  });

  it('answers 404 for unknown and other-tenant ids, 400 for malformed ones', async () => {
    const { app, call, green } = await setup();
    expect((await call(app, '/api/v1/locations/nope/stock')).status).toBe(404);
    expect((await call(app, `/api/v1/filaments/${green}/stock`)).status).toBe(404);
    expect((await call(app, `/api/v1/filaments/${uuid()}/stock`)).status).toBe(404);
    expect((await call(app, '/api/v1/filaments/not-a-uuid/stock')).status).toBe(400);
    expect((await call(app, '/api/v1/locations/BAD_ID/stock')).status).toBe(400);
  });

  it("never shows another tenant's catalog or stock", async () => {
    const { as, call, post, red } = await setup();
    await post(as(TENANT_A, [Scope.LocationsRead, Scope.InventoryWrite]), tap(red));
    const b = as(TENANT_B, [Scope.LocationsRead, Scope.InventoryWrite]);
    const list = (await (await call(b, '/api/v1/filaments')).json()) as {
      filaments: { color: string }[];
    };
    expect(list.filaments.map((f) => f.color)).toEqual(['Green']);
    const at = (await (await call(b, `/api/v1/locations/${SHELF}/stock`)).json()) as {
      lines: unknown[];
    };
    expect(at.lines).toEqual([]);
  });
});

describe('POST /api/v1/stock/adjust', () => {
  it('counts up and down and returns the line', async () => {
    const { app, post, red } = await setup();
    const up = await post(app, tap(red));
    expect(up.status).toBe(200);
    expect(await up.json()).toMatchObject({
      line: { count: 1, pack: 'spool' },
      check: { outcome: 'capacity_not_set' },
    });
    expect(await (await post(app, tap(red, SHELF, 'spool', -1))).json()).toMatchObject({
      line: { count: 0 },
    });
  });

  it('answers 422 below zero, for a refill of a disposable, a container and a slot', async () => {
    const { app, post, red, db } = await setup();
    const below = await post(app, tap(red, SHELF, 'spool', -1));
    expect([below.status, ((await below.json()) as { error: string }).error]).toEqual([
      422,
      'below_zero',
    ]);
    const refill = await post(app, tap(red, SHELF, 'refill'));
    expect([refill.status, ((await refill.json()) as { error: string }).error]).toEqual([
      422,
      'refill_not_allowed',
    ]);
    const room = await post(app, tap(red, 'closet-storage'));
    expect(room.status).toBe(422);
    const slot = db
      .prepare("SELECT id FROM location WHERE tenant_id = ? AND type = 'active_use' LIMIT 1")
      .get(TENANT_A) as { id: string };
    expect(((await (await post(app, tap(red, slot.id))).json()) as { error: string }).error).toBe(
      'slot_not_supported',
    );
  });

  it('answers 404 for unknown and other-tenant filaments and places', async () => {
    const { app, post, green, red } = await setup();
    expect((await post(app, tap(green))).status).toBe(404);
    expect((await post(app, tap(uuid()))).status).toBe(404);
    const place = await post(app, tap(red, 'no-such-place'));
    expect([place.status, ((await place.json()) as { error: string }).error]).toEqual([
      404,
      'location_not_found',
    ]);
  });

  it('asks 409 before a hard limit and goes through with confirm', async () => {
    const { app, post, red, db } = await setup();
    // Boxed stock goes on passive storage only (SPOOL-200); this passive shelf is set to a hard limit.
    const hard = 'closet-storage.shelf-2';
    db.prepare(
      "UPDATE location SET capacity = 1, capacity_mode = 'hard' WHERE tenant_id = ? AND id = ?",
    ).run(TENANT_A, hard);
    expect((await post(app, tap(red, hard))).status).toBe(200);
    const asked = await post(app, tap(red, hard));
    expect(asked.status).toBe(409);
    expect(await asked.json()).toMatchObject({
      error: 'needs_confirmation',
      check: { outcome: 'warning' },
    });
    const ok = await post(app, tap(red, hard, 'spool', 1, { confirm: true }));
    expect(await ok.json()).toMatchObject({ line: { count: 2 } });
  });

  describe('boxed stock on passive storage only (SPOOL-200)', () => {
    const errorOf = async (res: Response): Promise<[number, unknown]> => [
      res.status,
      await res.json(),
    ];

    it('answers 422 at active storage, a loaded slot and clip storage, and stores nothing', async () => {
      const { app, post, red, blue, db } = await setup();
      const slot = db
        .prepare("SELECT id FROM location WHERE tenant_id = ? AND type = 'active_use' LIMIT 1")
        .get(TENANT_A) as { id: string };
      for (const [place, error] of [
        ['loc1.shelf-1', 'not_passive_storage'],
        ['clips.bin-1', 'not_passive_storage'],
        [slot.id, 'slot_not_supported'],
      ] as const) {
        for (const body of [
          tap(red, place),
          tap(red, place, 'spool', 1, { confirm: true }),
          tap(blue, place, 'refill'),
          tap(red, place, 'spool', -1),
        ]) {
          expect(await errorOf(await post(app, body)), place).toEqual([422, { error }]);
        }
      }
      expect(db.prepare('SELECT COUNT(*) AS n FROM stock_line').get()).toMatchObject({ n: 0 });
      // Passive storage still works.
      expect(await (await post(app, tap(blue, SHELF, 'refill'))).json()).toMatchObject({
        line: { count: 1, pack: 'refill', location_id: SHELF },
      });
    });

    it("gives another tenant's place the same answer as an unknown place", async () => {
      const { as, post, red, green, db } = await setup();
      // Places only tenant A has: one the rule refuses, one it accepts.
      for (const [id, type, parent, mode] of [
        ['a-only-active', 'active_storage', 'loc1', 'hard'],
        ['a-only-bin', 'clip_storage', 'clips', 'soft'],
        ['a-only-passive', 'passive_storage', 'closet-storage', 'soft'],
      ] as const) {
        db.prepare(
          "INSERT INTO location (tenant_id, id, name, type, parent, leaf, capacity, capacity_mode, tag_source) VALUES (?, ?, 'A only', ?, ?, 1, 4, ?, 'sticker')",
        ).run(TENANT_A, id, type, parent, mode);
      }
      const b = as(TENANT_B, [Scope.LocationsRead, Scope.InventoryWrite]);
      const unknown = await errorOf(await post(b, tap(green, 'no-such-place')));
      expect(unknown).toEqual([404, { error: 'location_not_found' }]);
      for (const place of ['a-only-active', 'a-only-bin', 'a-only-passive']) {
        for (const delta of [1, -1]) {
          expect(await errorOf(await post(b, tap(green, place, 'spool', delta))), place).toEqual(
            unknown,
          );
        }
      }
      // And A's filament is not B's to use at all.
      expect((await post(b, tap(red, SHELF))).status).toBe(404);
      expect(db.prepare('SELECT COUNT(*) AS n FROM stock_line').get()).toMatchObject({ n: 0 });
    });

    it('lets a line left at an active shelf by an older database be tapped down to zero, never up', async () => {
      const { db, sql } = memoryDatabaseUpTo('0003_event_delete_grant.sql');
      await importSeed(sql, TENANT_A, readSeed(), readJson(SEED_SCHEMA_PATH));
      const red = uuid();
      db.prepare(
        "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, 'Acme', 'PLA', 'Red', 'disposable')",
      ).run(TENANT_A, red);
      db.prepare(
        "INSERT INTO stock_line (tenant_id, id, filament_id, location_id, pack, count) VALUES (?, ?, ?, 'loc1.shelf-1', 'spool', 1)",
      ).run(TENANT_A, uuid(), red);
      runMigrations(db);
      const app = createApp({
        auth: createDevTokenProvider({ token: TEST_TOKEN, tenantId: TENANT_A }),
        data: (p) => createScopedData(sql, p),
        allowedHosts: ['localhost'],
      });
      const send = (body: unknown) =>
        app.request('http://localhost/api/v1/stock/adjust', {
          method: 'POST',
          headers: { host: 'localhost', ...bearer, ...json },
          body: JSON.stringify(body),
        });
      expect(await errorOf(await send(tap(red, 'loc1.shelf-1')))).toEqual([
        422,
        { error: 'not_passive_storage' },
      ]);
      expect(await (await send(tap(red, 'loc1.shelf-1', 'spool', -1))).json()).toMatchObject({
        line: { count: 0, location_id: 'loc1.shelf-1' },
      });
      expect(await errorOf(await send(tap(red, 'loc1.shelf-1', 'spool', -1)))).toEqual([
        422,
        { error: 'not_passive_storage' },
      ]);
    });
  });

  it('needs the write scope', async () => {
    const { as, post, red } = await setup();
    const readOnly = as(TENANT_A, [Scope.LocationsRead]);
    expect((await post(readOnly, tap(red))).status).toBe(403);
  });

  it.each([
    ['not JSON', 'nope'],
    ['an array', '[1]'],
    ['an extra key (no weight, no cost)', JSON.stringify({ ...tap(uuid()), weight: 1000 })],
    ['delta 2', JSON.stringify(tap(uuid(), SHELF, 'spool', 2))],
    ['delta 0', JSON.stringify(tap(uuid(), SHELF, 'spool', 0))],
    ['an unknown pack', JSON.stringify(tap(uuid(), SHELF, 'box'))],
    ['a bad filament id', JSON.stringify(tap('x'))],
    ['a bad location id', JSON.stringify(tap(uuid(), 'Bad Id'))],
    ['a non-boolean confirm', JSON.stringify(tap(uuid(), SHELF, 'spool', 1, { confirm: 'yes' }))],
    ['a missing field', JSON.stringify({ filament_id: uuid(), location_id: SHELF })],
    [
      'a body over 1024 bytes',
      JSON.stringify({ ...tap(uuid()), confirm: false, pad: 'x'.repeat(2000) }),
    ],
  ])('rejects %s with 400', async (_name, body) => {
    const { app, post } = await setup();
    expect((await post(app, body)).status).toBe(400);
  });

  it('rejects a body that is not declared as JSON', async () => {
    const { app, post, red } = await setup();
    expect((await post(app, tap(red), { 'content-type': 'text/plain' })).status).toBe(400);
  });

  it('rejects an oversize body that declares no length (streamed in chunks)', async () => {
    const { app } = await setup();
    const chunk = new TextEncoder().encode('x'.repeat(600));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const res = await app.request('http://localhost/api/v1/stock/adjust', {
      method: 'POST',
      headers: { host: 'localhost', ...bearer, ...json },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(400);
  });
});
