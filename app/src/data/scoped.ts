// SPDX-License-Identifier: AGPL-3.0-or-later
// The tenant-scoped data layer (ADR-0004 decision 3). It is built from the authenticated Principal, and
// every query binds that Principal's tenant: route handlers never receive a raw database handle, so an
// unscoped query is not expressible from a handler. Each method also checks the scope it needs.
import { ForbiddenError, hasScope, Scope, type Principal } from '../auth/principal.ts';
import type { Sql } from '../db/sql.ts';
import type { LocationType } from '../seed/validate.ts';

export interface LocationTypeSummary {
  type: LocationType;
  locations: number;
  /** Sum of the capacities that are set; null when none is set (or for containers). */
  capacity_total: number | null;
  /** Leaves of this type whose capacity is not set yet. */
  capacity_unset: number;
}

export interface LocationSummary {
  total: number;
  by_type: LocationTypeSummary[];
}

export interface ScopedData {
  locationSummary(): Promise<LocationSummary>;
}

const TYPE_ORDER: readonly LocationType[] = [
  'container',
  'active_storage',
  'active_use',
  'passive_storage',
  'clip_storage',
];

interface Row {
  type: LocationType;
  locations: number;
  capacity_total: number | null;
  capacity_unset: number;
}

export function createScopedData(sql: Sql, principal: Principal): ScopedData {
  const tenantId = principal.tenantId;
  const require = (scope: typeof Scope.LocationsRead): void => {
    if (!hasScope(principal, scope)) throw new ForbiddenError(scope);
  };
  return {
    async locationSummary(): Promise<LocationSummary> {
      require(Scope.LocationsRead);
      const rows = await sql.all<Row>(
        `SELECT type,
                COUNT(*) AS locations,
                SUM(capacity) AS capacity_total,
                SUM(CASE WHEN capacity IS NULL THEN 1 ELSE 0 END) AS capacity_unset
           FROM location
          WHERE tenant_id = ?
          GROUP BY type`,
        [tenantId],
      );
      const byType = new Map(rows.map((r) => [r.type, r]));
      const by_type = TYPE_ORDER.map((type): LocationTypeSummary => {
        const row = byType.get(type);
        return {
          type,
          locations: row?.locations ?? 0,
          capacity_total: type === 'container' ? null : (row?.capacity_total ?? null),
          capacity_unset: type === 'container' ? 0 : (row?.capacity_unset ?? 0),
        };
      });
      return { total: by_type.reduce((n, t) => n + t.locations, 0), by_type };
    },
  };
}
