// SPDX-License-Identifier: AGPL-3.0-or-later
// The guarded delete for the event log (SPOOL-194, migration 0003). Events can be deleted only inside
// one atomic batch that opens a grant, deletes, and closes the grant again; the database refuses a
// commit that leaves a grant open. Only privileged operator code uses this module (tenant deletion,
// demo removal, later aggregation): it is never reachable from a route handler, which only ever gets
// the tenant-scoped data layer. A test fails if any other module names the grant table.
import type { Statement } from '../db/sql.ts';

/** Same rule as the tenant_id CHECK in the schema. */
const TENANT_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What a grant lets the batch delete: every event of the tenant, or only one filament's events. */
export type EventDeleteScope = { scope: 'tenant' } | { scope: 'filament'; filamentId: string };

export function checkTenantId(tenantId: string): void {
  if (!TENANT_ID.test(tenantId)) throw new Error('tenant id is malformed');
}

function check(tenantId: string, grant: EventDeleteScope): void {
  checkTenantId(tenantId);
  if (grant.scope === 'filament' && !UUID.test(grant.filamentId)) {
    throw new Error('filament id is malformed');
  }
}

/**
 * The statements that delete events under a grant: open, delete, close. Put them in the same batch
 * as the rest of the change; the close must come before anything the grant's foreign keys depend on
 * is deleted (the filament, for a filament grant).
 */
export function guardedEventDelete(tenantId: string, grant: EventDeleteScope): Statement[] {
  check(tenantId, grant);
  const open: Statement =
    grant.scope === 'tenant'
      ? {
          query: "INSERT INTO event_delete_grant (tenant_id, scope) VALUES (?, 'tenant')",
          params: [tenantId],
        }
      : {
          query:
            "INSERT INTO event_delete_grant (tenant_id, scope, filament_id) VALUES (?, 'filament', ?)",
          params: [tenantId, grant.filamentId],
        };
  const remove: Statement =
    grant.scope === 'tenant'
      ? { query: 'DELETE FROM event WHERE tenant_id = ?', params: [tenantId] }
      : {
          query: `DELETE FROM event
                   WHERE tenant_id = ?
                     AND (filament_id = ?
                          OR clip_id IN (SELECT id FROM clip WHERE tenant_id = ? AND filament_id = ?))`,
          params: [tenantId, grant.filamentId, tenantId, grant.filamentId],
        };
  const close: Statement = {
    query: 'DELETE FROM event_delete_grant WHERE tenant_id = ? AND scope = ?',
    params: [tenantId, grant.scope],
  };
  return [open, remove, close];
}
