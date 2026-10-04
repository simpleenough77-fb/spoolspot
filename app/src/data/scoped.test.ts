// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ForbiddenError, Scope, type Principal } from '../auth/principal.ts';
import { importSeed } from '../seed/import.ts';
import {
  memoryDatabase,
  readJson,
  readSeed,
  SEED_SCHEMA_PATH,
  TENANT_A,
  TENANT_B,
} from '../testing.ts';
import { createScopedData } from './scoped.ts';

const principal = (tenantId: string, scopes: string[] = [Scope.LocationsRead]): Principal => ({
  subject: `user-of-${tenantId}`,
  tenantId,
  scopes: new Set(scopes),
});

describe('tenant-scoped data layer', () => {
  it('counts locations by type for the seed', async () => {
    const { sql } = memoryDatabase();
    await importSeed(sql, TENANT_A, readSeed(), readJson(SEED_SCHEMA_PATH));
    const summary = await createScopedData(sql, principal(TENANT_A)).locationSummary();
    expect(summary.total).toBe(81);
    expect(Object.fromEntries(summary.by_type.map((t) => [t.type, t]))).toMatchObject({
      container: { locations: 27, capacity_total: null, capacity_unset: 0 },
      active_storage: { locations: 9, capacity_total: 107, capacity_unset: 0 },
      active_use: { locations: 30, capacity_total: 30, capacity_unset: 0 },
      passive_storage: { locations: 14, capacity_total: null, capacity_unset: 14 },
      clip_storage: { locations: 1, capacity_total: null, capacity_unset: 1 },
    });
    expect(summary.by_type.map((t) => t.type)).toEqual([
      'container',
      'active_storage',
      'active_use',
      'passive_storage',
      'clip_storage',
    ]);
  });

  it('reports every type, with zeros, for a tenant with no locations', async () => {
    const { sql, db } = memoryDatabase();
    db.prepare('INSERT INTO tenant_settings (tenant_id) VALUES (?)').run(TENANT_B);
    const summary = await createScopedData(sql, principal(TENANT_B)).locationSummary();
    expect(summary.total).toBe(0);
    expect(summary.by_type).toHaveLength(5);
  });

  it("never shows another tenant's data", async () => {
    const { sql, db } = memoryDatabase();
    await importSeed(sql, TENANT_A, readSeed(), readJson(SEED_SCHEMA_PATH));
    db.prepare('INSERT INTO tenant_settings (tenant_id) VALUES (?)').run(TENANT_B);
    db.prepare(
      `INSERT INTO location (tenant_id, id, name, type, leaf, capacity, capacity_mode, tag_source)
       VALUES (?, 'only-b', 'Only B', 'active_storage', 1, 5, 'hard', 'sticker')`,
    ).run(TENANT_B);

    const b = await createScopedData(sql, principal(TENANT_B)).locationSummary();
    expect(b.total).toBe(1);
    expect(b.by_type.find((t) => t.type === 'active_storage')).toMatchObject({
      locations: 1,
      capacity_total: 5,
    });

    const a = await createScopedData(sql, principal(TENANT_A)).locationSummary();
    expect(a.total).toBe(81);
    expect(a.by_type.find((t) => t.type === 'active_storage')).toMatchObject({
      locations: 9,
      capacity_total: 107,
    });
  });

  it('refuses a principal without the scope', async () => {
    const { sql } = memoryDatabase();
    await expect(
      createScopedData(sql, principal(TENANT_A, [])).locationSummary(),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      createScopedData(sql, principal(TENANT_A, ['locations:write'])).locationSummary(),
    ).rejects.toThrow(/missing scope/);
  });

  it('binds the tenant as a parameter, so a hostile tenant id returns nothing', async () => {
    const { sql } = memoryDatabase();
    await importSeed(sql, TENANT_A, readSeed(), readJson(SEED_SCHEMA_PATH));
    const hostile = principal("' OR '1'='1");
    expect((await createScopedData(sql, hostile).locationSummary()).total).toBe(0);
  });
});
