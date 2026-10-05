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
  /** 'leaf' for a place that holds units; 'container' for anywhere inside a container. */
  scope: 'leaf' | 'container';
  count: number;
  /** A leaf's mode; null for a container. */
  capacity_mode: CapacityMode | null;
  capacity: number | null;
  used: number;
  free: number | null;
  /** Free places left after the placement; null when capacity is not set. Negative means over. */
  free_after: number | null;
  /** Leaves whose room was counted (capacity set). Slots are skipped unless the container holds only slots. */
  leaves_counted: number;
  /** Leaves inside that were left out of the count because their capacity is not set yet. */
  leaves_without_capacity: number;
  /** True when one counted place has room for all `count` units; false when the room is spread over several. */
  fits_in_one_place: boolean;
  outcome: PlacementOutcome;
}

/**
 * What would happen if `count` units were placed at this location. Read-only: nothing is stored.
 * ok: fits. notice: over a soft limit (allowed). warning: over a hard limit (confirm first).
 * capacity_not_set: there is no limit to check against yet.
 *
 * For a container the question is "is there room somewhere inside": the room of every leaf below it
 * that has a capacity is added up, the same way the tree rolls it up. active_use slots are loaded by
 * the load workflow, so they are left out unless the container holds nothing else (an AMS, say). Over
 * the total, the outcome is a notice when any counted leaf has a soft limit (the units can go there),
 * and a warning when every counted leaf is a hard limit.
 */
export function checkPlacement(node: LocationNode, count: number): PlacementCheck {
  if (node.leaf) {
    const base = {
      location_id: node.id,
      scope: 'leaf' as const,
      count,
      capacity_mode: node.capacity_mode,
      capacity: node.capacity,
      used: node.used,
      free: node.free,
      leaves_counted: node.capacity === null ? 0 : 1,
      leaves_without_capacity: node.capacity === null ? 1 : 0,
      fits_in_one_place: node.capacity !== null && (node.free ?? 0) >= count,
    };
    if (node.capacity === null) return { ...base, free_after: null, outcome: 'capacity_not_set' };
    const freeAfter = node.capacity - node.used - count;
    if (freeAfter >= 0) return { ...base, free_after: freeAfter, outcome: 'ok' };
    return {
      ...base,
      free_after: freeAfter,
      outcome: node.capacity_mode === 'hard' ? 'warning' : 'notice',
    };
  }
  const inside = leaves(node.children);
  const slotsOnly = inside.length > 0 && inside.every((l) => l.type === 'active_use');
  const considered = slotsOnly ? inside : inside.filter((l) => l.type !== 'active_use');
  const counted = considered.filter((l) => l.capacity !== null);
  const capacity = sum(counted.map((l) => l.capacity ?? 0));
  const used = sum(counted.map((l) => l.used));
  const free = sum(counted.map((l) => l.free ?? 0));
  const base = {
    location_id: node.id,
    scope: 'container' as const,
    count,
    capacity_mode: null,
    leaves_counted: counted.length,
    leaves_without_capacity: considered.length - counted.length,
    fits_in_one_place: counted.some((l) => (l.free ?? 0) >= count),
  };
  if (counted.length === 0) {
    return {
      ...base,
      capacity: null,
      used: sum(considered.map((l) => l.used)),
      free: null,
      free_after: null,
      outcome: 'capacity_not_set',
    };
  }
  const freeAfter = free - count;
  const anySoft = counted.some((l) => l.capacity_mode === 'soft');
  return {
    ...base,
    capacity,
    used,
    free,
    free_after: freeAfter,
    outcome: freeAfter >= 0 ? 'ok' : anySoft ? 'notice' : 'warning',
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
 * Where there is room. Active_use slots are left out unless asked for by type. Leaves with no capacity set are excluded, and so is any full leaf: a suggestion
 * never goes over a limit, hard or soft. Most free places first, then name, so the order is stable.
 */
export function suggestPlacements(
  nodes: readonly LocationNode[],
  count: number,
  type?: LocationType,
  limit = 5,
  within?: LocationNode,
): PlacementSuggestion[] {
  const scope = leaves(within ? [within] : nodes);
  // Asking about a place that holds only slots (an AMS, or one slot) means the slots are wanted.
  const slotsOnly =
    within !== undefined && scope.length > 0 && scope.every((l) => l.type === 'active_use');
  const withRoom = scope.flatMap((l) => {
    const mode = l.capacity_mode;
    const free = l.free ?? 0;
    const eligible = l.capacity !== null && mode !== null && free > 0;
    // Slots are filled by the load workflow, so they are suggested only when asked for by type.
    const typeOk = type === undefined ? slotsOnly || l.type !== 'active_use' : l.type === type;
    return eligible && typeOk ? [{ l, mode, free }] : [];
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
