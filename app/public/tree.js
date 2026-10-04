// SPDX-License-Identifier: AGPL-3.0-or-later
// The location tree: Home, containers and leaves, collapsible with native <details> (keyboard and
// screen reader support come with the element). Each leaf shows used, capacity and free, and a hard or
// soft badge that is text, not only colour. Every value goes in with textContent.
import { getJson } from './api.js';

const MODE_LABEL = { hard: 'Hard limit', soft: 'Soft limit' };
const OPEN_DEPTH = 1;

function isNode(node, depth = 0) {
  return (
    depth < 40 &&
    node !== null &&
    typeof node === 'object' &&
    typeof node.id === 'string' &&
    typeof node.name === 'string' &&
    typeof node.leaf === 'boolean' &&
    Number.isInteger(node.used) &&
    Number.isInteger(node.over) &&
    Number.isInteger(node.capacity_unset) &&
    (node.capacity === null || Number.isInteger(node.capacity)) &&
    (node.free === null || Number.isInteger(node.free)) &&
    (node.capacity_mode === null || node.capacity_mode in MODE_LABEL) &&
    Array.isArray(node.children) &&
    node.children.every((child) => isNode(child, depth + 1))
  );
}

function text(tag, value, className) {
  const el = document.createElement(tag);
  el.textContent = value;
  if (className) el.className = className;
  return el;
}

/** "6 free of 16 (10 used)", "Capacity not set (3 used)", with an over-limit note when needed. */
export function describe(node) {
  if (node.capacity === null) {
    const unset = node.leaf ? 'Capacity not set' : `${node.capacity_unset} without capacity set`;
    return `${unset} (${node.used} used)`;
  }
  let text = `${node.free} free of ${node.capacity} (${node.used} used)`;
  if (node.over > 0) text += `, over by ${node.over}`;
  // Used counts every leaf below; free and capacity count only leaves with a capacity set.
  if (!node.leaf && node.capacity_unset > 0)
    text += `, ${node.capacity_unset} without capacity set`;
  return text;
}

function leafItem(node) {
  const li = document.createElement('li');
  li.className = 'leaf';
  li.append(text('span', node.name, 'name'), text('span', describe(node), 'figures'));
  if (node.capacity_mode) li.append(text('span', MODE_LABEL[node.capacity_mode], 'badge'));
  return li;
}

function containerItem(node, depth) {
  const li = document.createElement('li');
  const details = document.createElement('details');
  details.open = depth <= OPEN_DEPTH;
  const summary = document.createElement('summary');
  summary.append(text('span', node.name, 'name'), text('span', describe(node), 'figures'));
  const list = document.createElement('ul');
  for (const child of node.children) {
    list.append(child.leaf ? leafItem(child) : containerItem(child, depth + 1));
  }
  details.append(summary, list);
  li.append(details);
  return li;
}

/**
 * Flat list of leaves with a short label for the placement picker: the path without the root, and
 * without the parent when the leaf's own name already starts with it ("Location 1 - Shelf 2").
 */
export function leafPaths(nodes, path = [], isRoot = true) {
  return nodes.flatMap((node) => {
    if (!node.leaf) {
      return leafPaths(node.children, isRoot ? path : [...path, node.name], false);
    }
    const parent = path.at(-1);
    const shown = parent !== undefined && node.name.startsWith(parent) ? path.slice(0, -1) : path;
    return [
      {
        id: node.id,
        name: node.name,
        label: [...shown, node.name].join(' › '),
        // The containers above the leaf, without Home: the picker's group heading.
        group: path.join(' › ') || 'Home',
      },
    ];
  });
}

/** Loads and renders the tree; returns the nodes so the page can build the picker from them. */
export async function showTree() {
  const root = document.getElementById('tree');
  if (!root) throw new Error('tree element is missing');
  const data = await getJson('/api/v1/locations/tree');
  if (!data || !Array.isArray(data.locations) || !data.locations.every((n) => isNode(n))) {
    throw new Error('unexpected tree data');
  }
  const list = document.createElement('ul');
  list.className = 'tree';
  for (const node of data.locations) {
    list.append(node.leaf ? leafItem(node) : containerItem(node, 0));
  }
  root.replaceChildren(list);
  return data.locations;
}
