// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  buildTree,
  checkPlacement,
  leaves,
  suggestPlacements,
  type LocationRow,
  type LocationNode,
} from './tree.ts';

function container(id: string, parent: string | null): LocationRow {
  return {
    id,
    name: id,
    type: 'container',
    parent,
    leaf: 0,
    capacity: null,
    capacity_mode: null,
    used: 0,
  };
}

function leaf(
  id: string,
  parent: string,
  capacity: number | null,
  used: number,
  mode: 'hard' | 'soft' = 'hard',
  type: LocationRow['type'] = 'active_storage',
): LocationRow {
  return { id, name: id, type, parent, leaf: 1, capacity, capacity_mode: mode, used };
}

const rows: LocationRow[] = [
  container('home', null),
  container('active', 'home'),
  leaf('shelf-1', 'active', 16, 10),
  leaf('shelf-2', 'active', 16, 16),
  container('passive', 'home'),
  leaf('box-1', 'passive', 4, 5, 'soft', 'passive_storage'),
  leaf('box-2', 'passive', null, 3, 'soft', 'passive_storage'),
];

function find(nodes: readonly LocationNode[], id: string): LocationNode {
  const found = leaves(nodes).find((n) => n.id === id);
  if (!found) throw new Error(`no leaf ${id}`);
  return found;
}

describe('buildTree', () => {
  const tree = buildTree(rows);

  it('nests containers and leaves under Home', () => {
    expect(tree).toHaveLength(1);
    expect(tree[0]?.id).toBe('home');
    expect(tree[0]?.children.map((c) => c.id)).toEqual(['active', 'passive']);
  });

  it('shows a 16-place shelf with 10 items as 6 free', () => {
    expect(find(tree, 'shelf-1')).toMatchObject({ capacity: 16, used: 10, free: 6, over: 0 });
  });

  it('shows a full shelf as 0 free and an over-full soft location as over', () => {
    expect(find(tree, 'shelf-2')).toMatchObject({ used: 16, free: 0, over: 0 });
    expect(find(tree, 'box-1')).toMatchObject({ capacity: 4, used: 5, free: 0, over: 1 });
  });

  it('leaves free and capacity null when capacity is not set', () => {
    expect(find(tree, 'box-2')).toMatchObject({
      capacity: null,
      free: null,
      used: 3,
      capacity_unset: 1,
    });
  });

  it('rolls up containers from leaves, adding room per leaf rather than netting overflow', () => {
    const [home] = tree;
    expect(home).toMatchObject({
      used: 34,
      capacity: 36,
      free: 6,
      over: 1,
      capacity_unset: 1,
      leaf: false,
    });
    expect(tree[0]?.children[1]).toMatchObject({ capacity: 4, free: 0, used: 8 });
  });

  it('leaves a container with no capacity anywhere below it at null', () => {
    const empty = buildTree([container('home', null), container('room', 'home')]);
    expect(empty[0]).toMatchObject({ capacity: null, free: null, used: 0, capacity_unset: 0 });
  });

  it('refuses a tree deeper than supported instead of recursing forever', () => {
    const deep: LocationRow[] = [container('c0', null)];
    for (let i = 1; i <= 40; i += 1) deep.push(container(`c${String(i)}`, `c${String(i - 1)}`));
    expect(() => buildTree(deep)).toThrow(/deeper/);
  });
});

describe('checkPlacement', () => {
  const tree = buildTree(rows);

  it('is ok while the placement fits, including exactly filling the leaf', () => {
    expect(checkPlacement(find(tree, 'shelf-1'), 6)).toMatchObject({
      outcome: 'ok',
      free_after: 0,
    });
    expect(checkPlacement(find(tree, 'shelf-1'), 1)).toMatchObject({
      outcome: 'ok',
      free_after: 5,
    });
  });

  it('warns past a hard limit', () => {
    expect(checkPlacement(find(tree, 'shelf-1'), 7)).toMatchObject({
      outcome: 'warning',
      free_after: -1,
    });
    expect(checkPlacement(find(tree, 'shelf-2'), 1)).toMatchObject({ outcome: 'warning' });
  });

  it('allows past a soft limit with a notice', () => {
    expect(checkPlacement(find(tree, 'box-1'), 2)).toMatchObject({
      outcome: 'notice',
      free_after: -3,
    });
  });

  it('has no limit to check when capacity is not set', () => {
    expect(checkPlacement(find(tree, 'box-2'), 50)).toMatchObject({
      outcome: 'capacity_not_set',
      free_after: null,
    });
  });

  it('holds at most one unit in an active_use slot', () => {
    const slots = buildTree([
      container('home', null),
      leaf('slot-1', 'home', 1, 0, 'hard', 'active_use'),
      leaf('slot-2', 'home', 1, 1, 'hard', 'active_use'),
    ]);
    expect(checkPlacement(find(slots, 'slot-1'), 1).outcome).toBe('ok');
    expect(checkPlacement(find(slots, 'slot-1'), 2).outcome).toBe('warning');
    expect(checkPlacement(find(slots, 'slot-2'), 1).outcome).toBe('warning');
  });
});

describe('suggestPlacements', () => {
  const tree = buildTree(rows);

  it('leaves out leaves with no capacity set and full leaves, soft or hard', () => {
    const ids = suggestPlacements(tree, 1).map((s) => s.location_id);
    expect(ids).toEqual(['shelf-1']);
    expect(ids).not.toContain('box-2');
    expect(ids).not.toContain('box-1');
    expect(ids).not.toContain('shelf-2');
  });

  it('says whether everything fits', () => {
    expect(suggestPlacements(tree, 6)[0]).toMatchObject({ location_id: 'shelf-1', fits_all: true });
    expect(suggestPlacements(tree, 7)[0]).toMatchObject({
      location_id: 'shelf-1',
      fits_all: false,
    });
  });

  it('orders by most free places then name, and honours the type filter and limit', () => {
    const wide = buildTree([
      container('home', null),
      leaf('b', 'home', 10, 5),
      leaf('a', 'home', 10, 5),
      leaf('c', 'home', 20, 5),
      leaf('p', 'home', 9, 0, 'soft', 'passive_storage'),
    ]);
    expect(suggestPlacements(wide, 1).map((s) => s.location_id)).toEqual(['c', 'p', 'a', 'b']);
    expect(suggestPlacements(wide, 1, 'passive_storage').map((s) => s.location_id)).toEqual(['p']);
    expect(suggestPlacements(wide, 1, undefined, 2)).toHaveLength(2);
  });
});
