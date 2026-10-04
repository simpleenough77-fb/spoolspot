// SPDX-License-Identifier: AGPL-3.0-or-later
// Shows the location counts from /api/v1/locations/summary. All text goes in with textContent
// (output encoding).
import { getJson } from './api.js';

const LABELS = {
  container: 'Containers (rooms, shelving, printers)',
  active_storage: 'Active storage (open spools)',
  active_use: 'Active use (loaded slots)',
  passive_storage: 'Passive storage (boxed)',
  clip_storage: 'Clip storage',
};

function places(entry) {
  if (entry.type === 'container') return 'not applicable';
  if (entry.capacity_total === null) return 'not set';
  return entry.capacity_unset > 0
    ? `${entry.capacity_total} (${entry.capacity_unset} not set)`
    : String(entry.capacity_total);
}

function cell(tag, text) {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}

function valid(data) {
  return (
    data !== null &&
    typeof data === 'object' &&
    Number.isInteger(data.total) &&
    Array.isArray(data.by_type) &&
    data.by_type.every(
      (e) =>
        typeof e.type === 'string' &&
        Number.isInteger(e.locations) &&
        Number.isInteger(e.capacity_unset) &&
        (e.capacity_total === null || Number.isInteger(e.capacity_total)),
    )
  );
}

/** Loads and renders the summary table. Returns the total, or throws. */
export async function showSummary() {
  const table = document.getElementById('summary');
  const rows = document.getElementById('summary-rows');
  const total = document.getElementById('summary-total');
  if (!table || !rows || !total) throw new Error('summary elements are missing');
  const data = await getJson('/api/v1/locations/summary');
  if (!valid(data)) throw new Error('unexpected summary data');
  rows.replaceChildren();
  for (const entry of data.by_type) {
    const tr = document.createElement('tr');
    const th = cell('th', LABELS[entry.type] ?? entry.type);
    th.scope = 'row';
    tr.append(th, cell('td', String(entry.locations)), cell('td', places(entry)));
    rows.append(tr);
  }
  total.textContent = String(data.total);
  table.hidden = false;
  return data.total;
}
