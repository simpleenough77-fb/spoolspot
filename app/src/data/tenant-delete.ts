// SPDX-License-Identifier: AGPL-3.0-or-later
// Tenant deletion (SPOOL-194; ADR-0006 item 5): removes every row of one tenant, its events included,
// in one atomic batch. Privileged operator code, like the seed importer: it takes the tenant id from its
// caller and is not part of the tenant-scoped data layer, so no route handler can reach it. A route, its
// authorisation and any confirmation step are separate work.
import type { Sql } from '../db/sql.ts';
import { checkTenantId, guardedEventDelete } from './event-delete.ts';

export interface TenantDeletion {
  events: number;
  stockLines: number;
  clips: number;
  filaments: number;
  locations: number;
  /**
   * Tag registry rows left after clips and locations went. Deleting those already removes their tags
   * (triggers in migration 0002), so this counts only rows that had lost their record: normally 0.
   */
  orphanTags: number;
  /**
   * Retired tag IDs of the tenant (migration 0006), including those retired by this deletion's own
   * deletes of clips and places. They go with the tenant: the database lets them go only once the
   * tenant has no place, clip or registry row left.
   */
  retiredTags: number;
  /** 1 when the tenant existed, 0 when there was nothing to delete. */
  tenant: number;
}

/** Deletes everything one tenant has, or nothing if any step fails. Other tenants are never touched. */
export async function deleteTenant(sql: Sql, tenantId: string): Promise<TenantDeletion> {
  checkTenantId(tenantId);
  const [, events, , stockLines, clips, filaments, locations, orphanTags, retiredTags, tenant] =
    await sql.batch([
      // Events first, under a grant closed in the same batch: they reference clips, filaments and places.
      ...guardedEventDelete(tenantId, { scope: 'tenant' }),
      { query: 'DELETE FROM stock_line WHERE tenant_id = ?', params: [tenantId] },
      // Deleting a clip or location also removes its tag registry row (triggers in 0002), which
      // retires its ID (0006); the retired rows are deleted below with the rest of the tenant.
      { query: 'DELETE FROM clip WHERE tenant_id = ?', params: [tenantId] },
      { query: 'DELETE FROM filament WHERE tenant_id = ?', params: [tenantId] },
      // One statement for the whole tree: SQLite checks the parent foreign key at the end of it.
      { query: 'DELETE FROM location WHERE tenant_id = ?', params: [tenantId] },
      { query: 'DELETE FROM tag WHERE tenant_id = ?', params: [tenantId] },
      // After everything that retires an ID (0006): deleting a clip, a place or a registry row.
      { query: 'DELETE FROM tag_retired WHERE tenant_id = ?', params: [tenantId] },
      { query: 'DELETE FROM tenant_settings WHERE tenant_id = ?', params: [tenantId] },
    ]);
  return {
    events: events ?? 0,
    stockLines: stockLines ?? 0,
    clips: clips ?? 0,
    filaments: filaments ?? 0,
    locations: locations ?? 0,
    orphanTags: orphanTags ?? 0,
    retiredTags: retiredTags ?? 0,
    tenant: tenant ?? 0,
  };
}
