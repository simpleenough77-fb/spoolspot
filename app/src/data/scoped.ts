// SPDX-License-Identifier: AGPL-3.0-or-later
// The tenant-scoped data layer (ADR-0004 decision 3). It is built from the authenticated Principal, and
// every query binds that Principal's tenant: route handlers never receive a raw database handle, so an
// unscoped query is not expressible from a handler. Each method also checks the scope it needs.
import { ForbiddenError, hasScope, Scope, type Principal } from '../auth/principal.ts';
import type { Sql } from '../db/sql.ts';
import type { LocationType } from '../seed/validate.ts';
import {
  buildTree,
  checkPlacement,
  suggestPlacements,
  type LocationNode,
  type LocationRow,
  type PlacementCheck,
  type PlacementSuggestion,
} from './tree.ts';

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

/** Why a placement check cannot be answered. Unknown ids and other tenants' ids look the same. */
export type PlacementRefusal = 'not_found';

export interface ScopedData {
  locationSummary(): Promise<LocationSummary>;
  locationTree(): Promise<LocationNode[]>;
  /** Read-only: what would happen if `count` units were placed at the leaf, or anywhere in the container. */
  placementCheck(locationId: string, count: number): Promise<PlacementCheck | PlacementRefusal>;
  /** Leaves with room, most free first; `within` limits them to one location. Unset capacity is left out. */
  placementSuggestions(
    count: number,
    type?: LocationType,
    within?: string,
  ): Promise<PlacementSuggestion[] | PlacementRefusal>;
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
  const loadTree = async (): Promise<LocationNode[]> => {
    // `used` is derived: boxed counts at the location plus clips placed there. Both subqueries are
    // bound to the tenant, and so is the outer query.
    const rows = await sql.all<LocationRow>(
      `SELECT l.id, l.name, l.type, l.parent, l.leaf, l.capacity, l.capacity_mode,
              COALESCE((SELECT SUM(s.count) FROM stock_line s
                         WHERE s.tenant_id = l.tenant_id AND s.location_id = l.id), 0)
              + (SELECT COUNT(*) FROM clip c
                  WHERE c.tenant_id = l.tenant_id AND c.location_id = l.id) AS used
         FROM location l
        WHERE l.tenant_id = ?
        ORDER BY l.rowid`,
      [tenantId],
    );
    return buildTree(rows);
  };
  return {
    async locationTree(): Promise<LocationNode[]> {
      require(Scope.LocationsRead);
      return loadTree();
    },
    async placementCheck(locationId, count) {
      require(Scope.LocationsRead);
      const node = [...flatten(await loadTree())].find((n) => n.id === locationId);
      return node ? checkPlacement(node, count) : 'not_found';
    },
    async placementSuggestions(count, type, within) {
      require(Scope.LocationsRead);
      const tree = await loadTree();
      if (within === undefined) return suggestPlacements(tree, count, type);
      const node = [...flatten(tree)].find((n) => n.id === within);
      return node ? suggestPlacements(tree, count, type, 5, node) : 'not_found';
    },
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

function* flatten(nodes: readonly LocationNode[]): Generator<LocationNode> {
  for (const node of nodes) {
    yield node;
    yield* flatten(node.children);
  }
}
