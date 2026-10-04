// SPDX-License-Identifier: AGPL-3.0-or-later
// Development preview: shows the location counts from /api/v1/locations/summary.
// All text goes in with textContent (output encoding); the token stays in this tab's sessionStorage
// and is only ever sent in an Authorization header, never in a URL.
(() => {
  const LABELS = {
    container: 'Containers (rooms, shelving, printers)',
    active_storage: 'Active storage (open spools)',
    active_use: 'Active use (loaded slots)',
    passive_storage: 'Passive storage (boxed)',
    clip_storage: 'Clip storage',
  };
  const KEY = 'spoolspot-dev-token';

  const form = document.getElementById('token-form');
  const input = document.getElementById('token');
  const status = document.getElementById('status');
  const table = document.getElementById('summary');
  const rows = document.getElementById('summary-rows');
  const total = document.getElementById('summary-total');
  if (!form || !input || !status || !table || !rows || !total) return;

  function stored() {
    try {
      return sessionStorage.getItem(KEY);
    } catch {
      return null;
    }
  }
  function store(value) {
    try {
      if (value) sessionStorage.setItem(KEY, value);
      else sessionStorage.removeItem(KEY);
    } catch {
      /* private mode: the token just is not remembered */
    }
  }

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

  function render(data) {
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

  async function load(token) {
    table.hidden = true;
    status.textContent = 'Loading…';
    try {
      const response = await fetch('/api/v1/locations/summary', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      if (response.status === 401) {
        store(null);
        status.textContent = 'That token was not accepted. Check it and try again.';
        return;
      }
      if (!response.ok) {
        status.textContent = `The server could not load the counts (HTTP ${response.status}).`;
        return;
      }
      const data = await response.json();
      if (!valid(data)) {
        status.textContent = 'The server sent data this page does not understand.';
        return;
      }
      store(token);
      render(data);
      status.textContent = `Loaded ${data.total} locations.`;
    } catch {
      status.textContent = 'Could not reach the server. Check your network connection.';
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const token = input.value.trim();
    input.value = '';
    if (token) void load(token);
  });

  const remembered = stored();
  if (remembered) void load(remembered);
})();
