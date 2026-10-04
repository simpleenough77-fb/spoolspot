// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure location-tree logic (SPOOL-30): no database, no HTTP. Used and free are derived from what is
// stored at each leaf; nothing here is typed in by a person. Hard limits warn and are never suggested
// over; soft limits allow the placement with a notice; a leaf with no capacity is left out of
// suggestions.
import type { LocationType } from '../seed/validate.ts';

export type CapacityMode = 'hard' | 'soft';

/** One row from the database: a location and what is stored directly at it. */
export interface LocationRow {
  id: string;
  name: string;
  type: LocationType;
  parent: string | null;
  leaf: number;
  capacity: number | null;
  capacity_mode: CapacityMode | null;
  /** Boxed spools and refills (stock line counts) plus clips placed here. */
  used: number;
}

export interface LocationNode {
  id: string;
  name: string;
  type: LocationType;
  leaf: boolean;
  capacity_mode: CapacityMode | null;
  /** A leaf's own capacity; for a container, the sum of the capacities set below it. Null when none is set. */
  capacity: number | null;
  /** Units stored here, or in a container the total of every leaf below it. */
  used: number;
  /** Room left. For a container, the sum of each leaf's free places, so one full shelf never hides another's room. */
  free: number | null;
  /** Units beyond capacity (soft limits can be exceeded; a hard limit should not be). */
  over: number;
  /** Leaves at or below this node that have no capacity set yet. */
  capacity_unset: number;
  children: LocationNode[];
}

const MAX_DEPTH = 32;

/** Builds the forest of nodes (normally one root, Home). Orphans cannot occur (composite foreign key). */
export function buildTree(rows: readonly LocationRow[]): LocationNode[] {
  const byParent = new Map<string | null, LocationRow[]>();
  for (const row of rows) {
    const list = byParent.get(row.parent) ?? [];
    list.push(row);
    byParent.set(row.parent, list);
  }
  const build = (row: LocationRow, depth: number): LocationNode => {
    if (depth > MAX_DEPTH) throw new Error('location tree is deeper than supported');
    const kids = (byParent.get(row.id) ?? []).map((kid) => build(kid, depth + 1));
    if (row.leaf === 1) {
      const capacity = row.capacity;
      return {
        id: row.id,
        name: row.name,
        type: row.type,
        leaf: true,
        capacity_mode: row.capacity_mode,
        capacity,
        used: row.used,
        free: capacity === null ? null : Math.max(0, capacity - row.used),
        over: capacity === null ? 0 : Math.max(0, row.used - capacity),
        capacity_unset: capacity === null ? 1 : 0,
        children: [],
      };
    }
    const withCapacity = kids.filter((k) => k.capacity !== null);
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      leaf: false,
      capacity_mode: null,
      capacity: withCapacity.length === 0 ? null : sum(withCapacity.map((k) => k.capacity ?? 0)),
      used: sum(kids.map((k) => k.used)),
      free: withCapacity.length === 0 ? null : sum(withCapacity.map((k) => k.free ?? 0)),
      over: sum(kids.map((k) => k.over)),
      capacity_unset: sum(kids.map((k) => k.capacity_unset)),
      children: kids,
    };
  };
  return (byParent.get(null) ?? []).map((root) => build(root, 0));
}

function sum(values: readonly number[]): number {
  return values.reduce((n, v) => n + v, 0);
}

export function leaves(nodes: readonly LocationNode[]): LocationNode[] {
  return nodes.flatMap((n) => (n.leaf ? [n] : leaves(n.children)));
}

export type PlacementOutcome = 'ok' | 'notice' | 'warning' | 'capacity_not_set';

export interface PlacementCheck {
  location_id: string;
  count: number;
  capacity_mode: CapacityMode | null;
  capacity: number | null;
  used: number;
  free: number | null;
  /** Free places left after the placement; null when capacity is not set. Negative means over. */
  free_after: number | null;
  outcome: PlacementOutcome;
}

/**
 * What would happen if `count` units were placed at this leaf. Read-only: nothing is stored.
 * ok: fits. notice: over a soft limit (allowed). warning: over a hard limit (confirm first).
 * capacity_not_set: there is no limit to check against yet.
 */
export function checkPlacement(leaf: LocationNode, count: number): PlacementCheck {
  const base = {
    location_id: leaf.id,
    count,
    capacity_mode: leaf.capacity_mode,
    capacity: leaf.capacity,
    used: leaf.used,
    free: leaf.free,
  };
  if (leaf.capacity === null) {
    return { ...base, free_after: null, outcome: 'capacity_not_set' };
  }
  const freeAfter = leaf.capacity - leaf.used - count;
  if (freeAfter >= 0) return { ...base, free_after: freeAfter, outcome: 'ok' };
  return {
    ...base,
    free_after: freeAfter,
    outcome: leaf.capacity_mode === 'hard' ? 'warning' : 'notice',
  };
}

export interface PlacementSuggestion {
  location_id: string;
  name: string;
  type: LocationType;
  capacity_mode: CapacityMode;
  free: number;
  /** True when all `count` units fit here without going over. */
  fits_all: boolean;
}

/**
 * Where there is room. Leaves with no capacity set are excluded, and so is any full leaf: a suggestion
 * never goes over a limit, hard or soft. Most free places first, then name, so the order is stable.
 */
export function suggestPlacements(
  nodes: readonly LocationNode[],
  count: number,
  type?: LocationType,
  limit = 5,
): PlacementSuggestion[] {
  const withRoom = leaves(nodes).flatMap((l) => {
    const mode = l.capacity_mode;
    const free = l.free ?? 0;
    const eligible = l.capacity !== null && mode !== null && free > 0;
    return eligible && (type === undefined || l.type === type) ? [{ l, mode, free }] : [];
  });
  return withRoom
    .sort((a, b) => b.free - a.free || a.l.name.localeCompare(b.l.name))
    .slice(0, limit)
    .map(({ l, mode, free }) => ({
      location_id: l.id,
      name: l.name,
      type: l.type,
      capacity_mode: mode,
      free,
      fits_all: free >= count,
    }));
}
