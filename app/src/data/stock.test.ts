// SPDX-License-Identifier: AGPL-3.0-or-later
// SPOOL-63: boxed stock lines changed one tap at a time.
import { describe, expect, it } from 'vitest';
import { ForbiddenError, Scope, type Principal } from '../auth/principal.ts';
import type { Sql } from '../db/sql.ts';
import { importSeed } from '../seed/import.ts';
import {
  memoryDatabase,
  readJson,
  readSeed,
  SEED_SCHEMA_PATH,
  TENANT_A,
  TENANT_B,
  uuid,
} from '../testing.ts';
import { createScopedData } from './scoped.ts';

const principal = (tenantId: string, scopes: string[]): Principal => ({
  subject: 's',
  tenantId,
  scopes: new Set(scopes),
});
const RW = [Scope.LocationsRead, Scope.InventoryWrite];
const SHELF = 'closet-storage.shelf-1'; // passive, soft
const HARD = 'loc1.shelf-1'; // active storage, hard

async function setup() {
  const { sql, db } = memoryDatabase();
  await importSeed(sql, TENANT_A, readSeed(), readJson(SEED_SCHEMA_PATH));
  await importSeed(sql, TENANT_B, readSeed(), readJson(SEED_SCHEMA_PATH));
  const filament = (tenant: string, color: string, kind: 'refillable' | 'disposable') => {
    const id = uuid();
    db.prepare(
      'INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(tenant, id, 'Acme', 'PLA', color, kind);
    return id;
  };
  const disposable = filament(TENANT_A, 'Red', 'disposable');
  const refillable = filament(TENANT_A, 'Blue', 'refillable');
  const otherTenants = filament(TENANT_B, 'Green', 'refillable');
  const data = createScopedData(sql, principal(TENANT_A, RW));
  const lines = () =>
    db
      .prepare('SELECT pack, count FROM stock_line WHERE tenant_id = ? ORDER BY pack, count')
      .all(TENANT_A) as { pack: string; count: number }[];
  return { sql, db, data, disposable, refillable, otherTenants, lines };
}

describe('adjustStock', () => {
  it('creates the line on the first +1, then counts up and down one tap at a time', async () => {
    const { data, disposable } = await setup();
    const up = await data.adjustStock(disposable, SHELF, 'spool', 1, false);
    expect(up).toMatchObject({ ok: true, line: { count: 1, pack: 'spool', location_id: SHELF } });
    const up2 = await data.adjustStock(disposable, SHELF, 'spool', 1, false);
    expect(up2).toMatchObject({ ok: true, line: { count: 2 } });
    const down = await data.adjustStock(disposable, SHELF, 'spool', -1, false);
    expect(down).toMatchObject({ ok: true, line: { count: 1 } });
  });

  it('cannot go below zero, and says so without storing anything', async () => {
    const { data, disposable, lines } = await setup();
    expect(await data.adjustStock(disposable, SHELF, 'spool', -1, false)).toMatchObject({
      ok: false,
      refusal: 'below_zero',
    });
    expect(lines()).toEqual([]);
    await data.adjustStock(disposable, SHELF, 'spool', 1, false);
    await data.adjustStock(disposable, SHELF, 'spool', -1, false);
    expect(await data.adjustStock(disposable, SHELF, 'spool', -1, false)).toMatchObject({
      ok: false,
      refusal: 'below_zero',
    });
    expect(lines()).toEqual([{ pack: 'spool', count: 0 }]);
  });

  it('keeps spool and refill boxes of the same filament as separate lines', async () => {
    const { data, refillable, lines } = await setup();
    await data.adjustStock(refillable, SHELF, 'spool', 1, false);
    await data.adjustStock(refillable, SHELF, 'refill', 1, false);
    await data.adjustStock(refillable, SHELF, 'refill', 1, false);
    expect(lines()).toEqual([
      { pack: 'refill', count: 2 },
      { pack: 'spool', count: 1 },
    ]);
  });

  it('refuses a refill pack for a disposable filament and stores nothing', async () => {
    const { data, disposable, lines } = await setup();
    expect(await data.adjustStock(disposable, SHELF, 'refill', 1, false)).toMatchObject({
      ok: false,
      refusal: 'refill_not_allowed',
    });
    expect(lines()).toEqual([]);
  });

  it('refuses containers and slots, and unknown filaments and places', async () => {
    const { data, disposable } = await setup();
    expect(await data.adjustStock(disposable, 'closet-storage', 'spool', 1, false)).toMatchObject({
      refusal: 'not_a_leaf',
    });
    expect(await data.adjustStock(disposable, 'no-such-place', 'spool', 1, false)).toMatchObject({
      refusal: 'location_not_found',
    });
    expect(await data.adjustStock(uuid(), SHELF, 'spool', 1, false)).toMatchObject({
      refusal: 'filament_not_found',
    });
  });

  it('refuses a boxed count at a loaded slot', async () => {
    const { data, db, disposable } = await setup();
    const row = db
      .prepare("SELECT id FROM location WHERE tenant_id = ? AND type = 'active_use' LIMIT 1")
      .get(TENANT_A) as { id: string };
    expect(await data.adjustStock(disposable, row.id, 'spool', 1, false)).toMatchObject({
      ok: false,
      refusal: 'slot_not_supported',
    });
  });

  it('refuses at the maximum count', async () => {
    const { data, db, disposable } = await setup();
    await data.adjustStock(disposable, SHELF, 'spool', 1, false);
    db.prepare('UPDATE stock_line SET count = 10000 WHERE tenant_id = ?').run(TENANT_A);
    expect(await data.adjustStock(disposable, SHELF, 'spool', 1, false)).toMatchObject({
      refusal: 'at_maximum',
    });
    expect(await data.adjustStock(disposable, SHELF, 'spool', -1, false)).toMatchObject({
      ok: true,
      line: { count: 9999 },
    });
  });

  it("keeps tenants apart: another tenant's filament and place are not found", async () => {
    const { sql, data, otherTenants, disposable, lines } = await setup();
    expect(await data.adjustStock(otherTenants, SHELF, 'spool', 1, false)).toMatchObject({
      refusal: 'filament_not_found',
    });
    expect(lines()).toEqual([]);
    // Tenant B holds the same place ids, but A's filament is not B's to use.
    const b = createScopedData(sql, principal(TENANT_B, RW));
    expect(await b.adjustStock(disposable, SHELF, 'spool', 1, false)).toMatchObject({
      refusal: 'filament_not_found',
    });
    expect(lines()).toEqual([]);
  });

  it('lets a soft limit go over with a notice', async () => {
    const { data, db, disposable } = await setup();
    db.prepare('UPDATE location SET capacity = 1 WHERE tenant_id = ? AND id = ?').run(
      TENANT_A,
      SHELF,
    );
    await data.adjustStock(disposable, SHELF, 'spool', 1, false);
    const over = await data.adjustStock(disposable, SHELF, 'spool', 1, false);
    expect(over).toMatchObject({ ok: true, line: { count: 2 }, check: { outcome: 'notice' } });
  });

  it('asks before going over a hard limit, and only the confirmed tap goes through', async () => {
    const { data, db, disposable, lines } = await setup();
    db.prepare('UPDATE location SET capacity = 1 WHERE tenant_id = ? AND id = ?').run(
      TENANT_A,
      HARD,
    );
    expect(await data.adjustStock(disposable, HARD, 'spool', 1, false)).toMatchObject({ ok: true });
    const asked = await data.adjustStock(disposable, HARD, 'spool', 1, false);
    expect(asked).toMatchObject({
      ok: false,
      refusal: 'needs_confirmation',
      check: { outcome: 'warning' },
    });
    expect(lines()).toEqual([{ pack: 'spool', count: 1 }]);
    expect(await data.adjustStock(disposable, HARD, 'spool', 1, true)).toMatchObject({
      ok: true,
      line: { count: 2 },
    });
  });

  it('counts clips toward a hard limit', async () => {
    const { data, db, disposable } = await setup();
    db.prepare('UPDATE location SET capacity = 1 WHERE tenant_id = ? AND id = ?').run(
      TENANT_A,
      HARD,
    );
    db.prepare(
      "INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, ?, 'ABCDEFGHJK12', ?, ?, 'on_spool')",
    ).run(TENANT_A, uuid(), disposable, HARD);
    expect(await data.adjustStock(disposable, HARD, 'spool', 1, false)).toMatchObject({
      refusal: 'needs_confirmation',
    });
  });

  it('stops a hard-limit overflow that races past the check (guard inside the write)', async () => {
    const { sql, db, disposable, refillable, lines } = await setup();
    db.prepare('UPDATE location SET capacity = 1 WHERE tenant_id = ? AND id = ?').run(
      TENANT_A,
      HARD,
    );
    // Between the check and the write another request fills the last place.
    const racing: Sql = {
      all: (q, p) => sql.all(q, p),
      batch: (statements) => {
        db.prepare(
          "INSERT INTO stock_line (tenant_id, id, filament_id, location_id, pack, count) VALUES (?, ?, ?, ?, 'spool', 1)",
        ).run(TENANT_A, uuid(), refillable, HARD);
        return sql.batch(statements);
      },
    };
    const data = createScopedData(racing, principal(TENANT_A, RW));
    expect(await data.adjustStock(disposable, HARD, 'spool', 1, false)).toMatchObject({
      ok: false,
      refusal: 'conflict',
    });
    expect(lines()).toEqual([{ pack: 'spool', count: 1 }]);
  });

  it('needs the write scope, and the read scope', async () => {
    const { sql, disposable } = await setup();
    const readOnly = createScopedData(sql, principal(TENANT_A, [Scope.LocationsRead]));
    await expect(readOnly.adjustStock(disposable, SHELF, 'spool', 1, false)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const none = createScopedData(sql, principal(TENANT_A, []));
    await expect(none.filaments()).rejects.toBeInstanceOf(ForbiddenError);
    await expect(none.stockAt(SHELF)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(none.stockOf(disposable)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('listing', () => {
  it('lists the catalog in a stable order, for this tenant only', async () => {
    const { data } = await setup();
    const list = await data.filaments();
    expect(list.map((f) => f.color)).toEqual(['Blue', 'Red']);
    expect(list[0]).toMatchObject({ manufacturer: 'Acme', type: 'PLA', spool_kind: 'refillable' });
  });

  it('shows every line at a place (zero included) and where a filament is held (above zero only)', async () => {
    const { data, disposable } = await setup();
    await data.adjustStock(disposable, SHELF, 'spool', 1, false);
    await data.adjustStock(disposable, HARD, 'spool', 1, false);
    await data.adjustStock(disposable, HARD, 'spool', -1, false);
    const here = await data.stockAt(HARD);
    expect(here).toMatchObject([{ count: 0, filament: { color: 'Red' } }]);
    const where = await data.stockOf(disposable);
    expect(where?.map((l) => [l.location_id, l.count])).toEqual([[SHELF, 1]]);
  });

  it('answers null for unknown or other-tenant ids', async () => {
    const { data, otherTenants } = await setup();
    expect(await data.stockAt('nope')).toBeNull();
    expect(await data.stockOf(uuid())).toBeNull();
    expect(await data.stockOf(otherTenants)).toBeNull();
  });
});

describe('concurrent taps on one line', () => {
  const both = async (
    first: [1 | -1, boolean],
    second: [1 | -1, boolean],
    start: number,
    capacity?: number,
  ) => {
    const s = await setup();
    if (capacity !== undefined) {
      s.db
        .prepare('UPDATE location SET capacity = ? WHERE tenant_id = ? AND id = ?')
        .run(capacity, TENANT_A, HARD);
    }
    for (let i = 0; i < start; i += 1)
      await s.data.adjustStock(s.disposable, HARD, 'spool', 1, true);
    const results = await Promise.all([
      s.data.adjustStock(s.disposable, HARD, 'spool', first[0], first[1]),
      s.data.adjustStock(s.disposable, HARD, 'spool', second[0], second[1]),
    ]);
    const final = s.db.prepare('SELECT count FROM stock_line').get() as
      { count: number } | undefined;
    return { results, final: final?.count ?? 0 };
  };

  it('two +1 at a hard capacity of 1: one is applied, the other is told nothing changed', async () => {
    const { results, final } = await both([1, false], [1, false], 0, 1);
    expect(final).toBe(1);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const refusals = results.flatMap((r) => (r.ok ? [] : [r.refusal]));
    expect(refusals).toHaveLength(1);
    expect(['conflict', 'needs_confirmation']).toContain(refusals[0]);
  });

  it('+1 racing -1 at 2: both apply, neither is reported as a conflict, the net is zero', async () => {
    const { results, final } = await both([1, true], [-1, false], 2);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(final).toBe(2);
  });

  it('two -1 at 1: one is applied, the other is told it is already at zero', async () => {
    const { results, final } = await both([-1, false], [-1, false], 1);
    expect(final).toBe(0);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.flatMap((r) => (r.ok ? [] : [r.refusal]))).toEqual(['below_zero']);
  });

  it('two -1 at 2 both apply', async () => {
    const { results, final } = await both([-1, false], [-1, false], 2);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(final).toBe(0);
  });
});
