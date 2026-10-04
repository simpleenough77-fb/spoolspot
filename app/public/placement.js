// SPDX-License-Identifier: AGPL-3.0-or-later
// "Can I put this here?": pick a leaf, tap + or - for how many, and the page says what would happen.
// It only asks; nothing is stored. A hard limit warns, a soft limit allows with a notice, and a leaf
// with no capacity says so. Suggestions list where there is room and never include leaves with no
// capacity set. Everything is chosen by tapping; there is nothing to type.
import { getJson } from './api.js';
import { leafPaths } from './tree.js';

const MAX = 1000;

export function message(check) {
  const { outcome, count } = check;
  const over = check.free_after === null ? 0 : Math.max(0, -check.free_after);
  switch (outcome) {
    case 'ok':
      return `Fits. ${check.free_after} free after adding ${count}.`;
    case 'notice':
      return `Notice: adding ${count} goes ${over} over the soft limit. You can still place it.`;
    case 'warning':
      return `Warning: adding ${count} goes ${over} over the hard limit. Check before placing it.`;
    default:
      return 'Capacity is not set for this location, so there is no limit to check.';
  }
}

function validCheck(c) {
  return (
    c !== null &&
    typeof c === 'object' &&
    typeof c.outcome === 'string' &&
    Number.isInteger(c.count) &&
    (c.free_after === null || Number.isInteger(c.free_after))
  );
}

function validSuggestions(d) {
  return (
    d !== null &&
    typeof d === 'object' &&
    Array.isArray(d.suggestions) &&
    d.suggestions.every(
      (s) =>
        typeof s.location_id === 'string' &&
        Number.isInteger(s.free) &&
        typeof s.fits_all === 'boolean' &&
        typeof s.capacity_mode === 'string',
    )
  );
}

export function setupPlacement(nodes, onError) {
  const section = document.getElementById('placement');
  const select = document.getElementById('place-location');
  const countOut = document.getElementById('place-count');
  const less = document.getElementById('place-less');
  const more = document.getElementById('place-more');
  const result = document.getElementById('place-result');
  const suggestions = document.getElementById('place-suggestions');
  if (!section || !select || !countOut || !less || !more || !result || !suggestions) {
    throw new Error('placement elements are missing');
  }

  const paths = leafPaths(nodes);
  const labels = new Map(paths.map((p) => [p.id, p.label]));
  select.replaceChildren();
  const groups = new Map();
  for (const p of paths) {
    let group = groups.get(p.group);
    if (!group) {
      group = document.createElement('optgroup');
      group.label = p.group;
      groups.set(p.group, group);
      select.append(group);
    }
    const option = document.createElement('option');
    option.value = p.id;
    option.textContent = p.label;
    group.append(option);
  }

  let count = 1;
  let sequence = 0;
  const show = () => {
    countOut.textContent = String(count);
    less.disabled = count <= 1;
    more.disabled = count >= MAX;
  };

  async function refresh() {
    show();
    const mine = ++sequence;
    try {
      const id = encodeURIComponent(select.value);
      const [check, near] = await Promise.all([
        getJson(`/api/v1/locations/${id}/placement?count=${String(count)}`),
        getJson(`/api/v1/placement-suggestions?count=${String(count)}`),
      ]);
      if (mine !== sequence) return; // a newer tap has already asked
      if (!validCheck(check) || !validSuggestions(near)) throw new Error('unexpected data');
      result.textContent = message(check);
      result.dataset.outcome = check.outcome;
      suggestions.replaceChildren();
      for (const s of near.suggestions) {
        const li = document.createElement('li');
        const where = labels.get(s.location_id) ?? s.name;
        const fit = s.fits_all ? '' : ` (room for ${s.free}, not all ${count})`;
        li.textContent = `${where}: ${s.free} free, ${s.capacity_mode} limit${fit}`;
        suggestions.append(li);
      }
      if (near.suggestions.length === 0) {
        const li = document.createElement('li');
        li.textContent = 'No location with a capacity set has room.';
        suggestions.append(li);
      }
    } catch (error) {
      if (mine === sequence) onError(error);
    }
  }

  select.addEventListener('change', () => void refresh());
  less.addEventListener('click', () => {
    count = Math.max(1, count - 1);
    void refresh();
  });
  more.addEventListener('click', () => {
    count = Math.min(MAX, count + 1);
    void refresh();
  });
  section.hidden = false;
  return refresh();
}
