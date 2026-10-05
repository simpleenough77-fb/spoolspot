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
import { normalizeTagId } from './tags.ts';

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

/** What a tag points at, in the caller's tenant. */
export interface TagTarget {
  kind: 'location' | 'clip';
  target_id: string;
}

/** A clip as shown to the person: its filament and where it is now. */
export interface ClipSummary {
  id: string;
  state: 'on_spool' | 'spool_empty' | 'free';
  location_id: string | null;
  filament: { manufacturer: string; type: string; color: string };
}

/** What a tag stands for, in the caller's tenant. */
export type TagView =
  | { kind: 'clip'; clip: ClipSummary }
  | {
      kind: 'location';
      location: {
        id: string;
        name: string;
        type: LocationType;
        leaf: boolean;
        capacity_mode: LocationNode['capacity_mode'];
        capacity: number | null;
        used: number;
        free: number | null;
      };
    };

export type MoveRefusal =
  | 'clip_not_found'
  | 'location_not_found'
  | 'not_a_leaf'
  | 'slot_not_supported'
  | 'needs_confirmation'
  /** The clip or the place changed between the check and the write; nothing was stored. Try again. */
  | 'conflict';

export type MoveResult =
  | { ok: true; moved: boolean; clip: ClipSummary; check: PlacementCheck }
  | { ok: false; refusal: MoveRefusal; check?: PlacementCheck };

export interface ScopedData {
  /** The clip or location a tag stands for; null for a malformed, unknown or other tenant's tag. */
  tagView(tagId: string): Promise<TagView | null>;
  /** Clips stored at one place (at most 200), or null when the place does not exist. */
  clipsAt(locationId: string): Promise<ClipSummary[] | null>;
  /**
   * Moves one clip to a place that holds units and records the move in the event log, atomically. A
   * hard limit asks for `confirm`; a soft limit and an unset capacity go through. Slots are loaded and
   * unloaded by the load workflow, not moved (SPOOL-84).
   */
  moveClip(clipId: string, toLocationId: string, confirm: boolean): Promise<MoveResult>;
  /**
   * Looks a tag up in the caller's tenant. A malformed ID, an unknown ID and another tenant's ID all
   * give null, so nothing can be learned from the difference.
   */
  resolveTag(tagId: string): Promise<TagTarget | null>;
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
  const resolve = async (tagId: string): Promise<TagTarget | null> => {
    const id = normalizeTagId(tagId);
    if (id === null) return null;
    const rows = await sql.all<TagTarget>(
      'SELECT kind, target_id FROM tag WHERE tenant_id = ? AND tag_id = ?',
      [tenantId, id],
    );
    return rows[0] ?? null;
  };
  const requireWrite = (): void => {
    if (!hasScope(principal, Scope.InventoryWrite)) throw new ForbiddenError(Scope.InventoryWrite);
  };
  const CLIP_SELECT = `SELECT c.id, c.state, c.location_id, f.manufacturer, f.type, f.color
         FROM clip c
         JOIN filament f ON f.tenant_id = c.tenant_id AND f.id = c.filament_id`;
  interface ClipRow {
    id: string;
    state: ClipSummary['state'];
    location_id: string | null;
    manufacturer: string;
    type: string;
    color: string;
  }
  const toClip = (r: ClipRow): ClipSummary => ({
    id: r.id,
    state: r.state,
    location_id: r.location_id,
    filament: { manufacturer: r.manufacturer, type: r.type, color: r.color },
  });
  const clipById = async (id: string): Promise<ClipSummary | null> => {
    const rows = await sql.all<ClipRow>(`${CLIP_SELECT} WHERE c.tenant_id = ? AND c.id = ?`, [
      tenantId,
      id,
    ]);
    const row = rows[0];
    return row ? toClip(row) : null;
  };
  return {
    async tagView(tagId) {
      require(Scope.LocationsRead);
      const target = await resolve(tagId);
      if (target === null) return null;
      if (target.kind === 'clip') {
        const clip = await clipById(target.target_id);
        return clip ? { kind: 'clip', clip } : null;
      }
      const node = [...flatten(await loadTree())].find((n) => n.id === target.target_id);
      if (!node) return null;
      return {
        kind: 'location',
        location: {
          id: node.id,
          name: node.name,
          type: node.type,
          leaf: node.leaf,
          capacity_mode: node.capacity_mode,
          capacity: node.capacity,
          used: node.used,
          free: node.free,
        },
      };
    },
    async clipsAt(locationId) {
      require(Scope.LocationsRead);
      const exists = [...flatten(await loadTree())].some((n) => n.id === locationId);
      if (!exists) return null;
      const rows = await sql.all<ClipRow>(
        `${CLIP_SELECT} WHERE c.tenant_id = ? AND c.location_id = ? ORDER BY c.rowid LIMIT 200`,
        [tenantId, locationId],
      );
      return rows.map(toClip);
    },
    async moveClip(clipId, toLocationId, confirm) {
      require(Scope.LocationsRead);
      requireWrite();
      const clip = await clipById(clipId);
      if (!clip) return { ok: false, refusal: 'clip_not_found' };
      const nodes = [...flatten(await loadTree())];
      const destination = nodes.find((n) => n.id === toLocationId);
      if (!destination) return { ok: false, refusal: 'location_not_found' };
      if (!destination.leaf) return { ok: false, refusal: 'not_a_leaf' };
      const from = nodes.find((n) => n.id === clip.location_id);
      if (destination.type === 'active_use' || from?.type === 'active_use') {
        return { ok: false, refusal: 'slot_not_supported' };
      }
      if (clip.location_id === destination.id) {
        // Already there: nothing to store. The count excludes the clip, which is already counted.
        const stay = checkPlacement(destination, 0);
        return { ok: true, moved: false, clip, check: stay };
      }
      const check = checkPlacement(destination, 1);
      if (check.outcome === 'warning' && !confirm) {
        return { ok: false, refusal: 'needs_confirmation', check };
      }
      // One atomic batch. Both statements carry the same guard, evaluated inside the write: the clip must
      // still be where we read it, and a hard limit must still have room unless the person confirmed.
      // If another request got there first the guard fails, nothing is stored, and we report a conflict.
      const guard = (clipTable: string): string =>
        `${clipTable}.location_id IS ?
         AND (? = 1 OR NOT EXISTS (
           SELECT 1 FROM location d
            WHERE d.tenant_id = ${clipTable}.tenant_id AND d.id = ?
              AND d.capacity_mode = 'hard' AND d.capacity IS NOT NULL
              AND COALESCE((SELECT SUM(s.count) FROM stock_line s
                             WHERE s.tenant_id = d.tenant_id AND s.location_id = d.id), 0)
                  + (SELECT COUNT(*) FROM clip k
                      WHERE k.tenant_id = d.tenant_id AND k.location_id = d.id) >= d.capacity))`;
      const guardParams = [clip.location_id, confirm ? 1 : 0, destination.id];
      await sql.batch([
        {
          query: `INSERT INTO event (tenant_id, id, type, clip_id, filament_id, from_location_id, to_location_id)
                  SELECT c.tenant_id, ?, 'move', c.id, c.filament_id, c.location_id, ?
                    FROM clip c WHERE c.tenant_id = ? AND c.id = ? AND ${guard('c')}`,
          params: [crypto.randomUUID(), destination.id, tenantId, clip.id, ...guardParams],
        },
        {
          query: `UPDATE clip SET location_id = ? WHERE tenant_id = ? AND id = ? AND ${guard('clip')}`,
          params: [destination.id, tenantId, clip.id, ...guardParams],
        },
      ]);
      const after = await clipById(clip.id);
      if (after?.location_id !== destination.id) return { ok: false, refusal: 'conflict' };
      return { ok: true, moved: true, clip: after, check };
    },
    async locationTree(): Promise<LocationNode[]> {
      require(Scope.LocationsRead);
      return loadTree();
    },
    async resolveTag(tagId) {
      require(Scope.LocationsRead);
      return resolve(tagId);
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
