// SPDX-License-Identifier: AGPL-3.0-or-later
// "Can I put this here?": pick a place or a whole container, tap + or - for how many, and the page says what would happen.
// It only asks; nothing is stored. A hard limit warns, a soft limit allows with a notice, and a leaf
// with no capacity says so. Suggestions list where there is room and never include leaves with no
// capacity set. Everything is chosen by tapping; there is nothing to type.
import { getJson } from './api.js';
import { leafPaths, pickerNodes } from './tree.js';

const MAX = 1000;
// Set up again on every load: the previous listeners and any answer still in flight are dropped, so a
// second submit can never leave two sets of handlers fighting over the result.
let controller = null;
let sequence = 0;

const plural = (n, word) => `${String(n)} ${word}${n === 1 ? '' : 's'}`;

export function message(check) {
  const { outcome, count } = check;
  const over = check.free_after === null ? 0 : Math.max(0, -check.free_after);
  const inside = check.scope === 'container';
  const where = inside ? ' in total' : '';
  const skipped =
    inside && check.leaves_without_capacity > 0
      ? ` ${plural(check.leaves_without_capacity, 'place')} inside ${check.leaves_without_capacity === 1 ? 'has' : 'have'} no capacity set and ${check.leaves_without_capacity === 1 ? 'is' : 'are'} not counted.`
      : '';
  const spread =
    inside && check.fits_in_one_place === false
      ? ' The room is spread over several places; no single place holds all of it.'
      : '';
  switch (outcome) {
    case 'ok':
      return `Fits. ${check.free_after} free after adding ${count}${where}, ${inside ? `, counting ${plural(check.leaves_counted, 'place')}` : ''}.${spread}${skipped}`;
    case 'notice':
      return `Notice: adding ${count} goes ${over} over${inside ? ' the room inside, and some places have a soft limit' : ' the soft limit'}. You can still place it.${skipped}`;
    case 'warning':
      return `Warning: adding ${count} goes ${over} over ${inside ? 'the room inside, and every counted place has a hard limit' : 'the hard limit'}. Check before placing it.${skipped}`;
    default:
      return inside
        ? `No place inside has a capacity set, so there is no limit to check.${skipped}`
        : 'Capacity is not set for this location, so there is no limit to check.';
  }
}

function validCheck(c) {
  return (
    c !== null &&
    typeof c === 'object' &&
    typeof c.outcome === 'string' &&
    Number.isInteger(c.count) &&
    (c.free_after === null || Number.isInteger(c.free_after)) &&
    (c.scope === 'leaf' || c.scope === 'container') &&
    Number.isInteger(c.leaves_counted) &&
    Number.isInteger(c.leaves_without_capacity) &&
    typeof c.fits_in_one_place === 'boolean'
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

  controller?.abort();
  controller = new AbortController();
  const { signal } = controller;
  sequence += 1;

  const paths = leafPaths(nodes);
  if (paths.length === 0) {
    section.hidden = true;
    return Promise.resolve();
  }
  const labels = new Map(paths.map((p) => [p.id, p.label]));
  const kinds = new Map();
  select.replaceChildren();
  for (const p of pickerNodes(nodes)) {
    kinds.set(p.id, p.leaf ? 'leaf' : 'container');
    const option = document.createElement('option');
    option.value = p.id;
    // Indented by depth; a container says it means anywhere inside it.
    // The full path is the option text, so it stays unambiguous without the indentation.
    option.textContent =
      '\u00a0\u00a0'.repeat(p.depth) + (p.leaf ? p.label : `${p.label} (anywhere inside)`);
    select.append(option);
  }
  // Start on a place that holds units, not on Home.
  const firstLeaf = paths[0];
  if (firstLeaf) select.value = firstLeaf.id;

  let count = 1;
  // aria-disabled, not disabled: a button that has focus must not vanish from the tab order mid-tap.
  const show = () => {
    countOut.textContent = String(count);
    less.setAttribute('aria-disabled', String(count <= 1));
    more.setAttribute('aria-disabled', String(count >= MAX));
  };

  async function refresh() {
    show();
    sequence += 1;
    const mine = sequence;
    try {
      const id = encodeURIComponent(select.value);
      // Inside a container, suggestions stay inside it; for a single place they cover everywhere.
      const within = kinds.get(select.value) === 'container' ? `&within=${id}` : '';
      const [check, near] = await Promise.all([
        getJson(`/api/v1/locations/${id}/placement?count=${String(count)}`),
        getJson(`/api/v1/placement-suggestions?count=${String(count)}${within}`),
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
        li.textContent = within
          ? 'No place inside has a capacity set and room.'
          : 'No location with a capacity set has room.';
        suggestions.append(li);
      }
    } catch (error) {
      if (mine === sequence) onError(error);
    }
  }

  select.addEventListener('change', () => void refresh(), { signal });
  less.addEventListener(
    'click',
    () => {
      if (count <= 1) return;
      count -= 1;
      void refresh();
    },
    { signal },
  );
  more.addEventListener(
    'click',
    () => {
      if (count >= MAX) return;
      count += 1;
      void refresh();
    },
    { signal },
  );
  section.hidden = false;
  return refresh();
}
