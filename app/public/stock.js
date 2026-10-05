// SPDX-License-Identifier: AGPL-3.0-or-later
// Boxed stock (SPOOL-63): pick a place, see what is boxed there, change a count with + and - taps, add a
// filament to the place by choosing manufacturer, type and color (no typing), and look up where one
// filament is held. Refill packs are offered only for refillable filaments. Past a hard limit the page
// warns and asks again ("Add anyway"). Every value goes in with textContent.
import { ApiError, getJson, postJson } from './api.js';
import { leafPaths } from './tree.js';

const PACK = { spool: 'Spool', refill: 'Refill' };
const REFUSALS = {
  below_zero: 'The count is already zero. Nothing changed.',
  refill_not_allowed: 'Refill packs are only for refillable filaments. Nothing changed.',
  not_a_leaf: 'Choose a shelf or drawer, not a whole room. Nothing changed.',
  slot_not_supported: 'A loaded slot holds its spool through its clip, not a boxed count.',
  at_maximum: 'That is the largest count this page allows. Nothing changed.',
  conflict: 'That changed while you were looking. Nothing was changed; try again.',
  not_found: 'That filament or place is not recognised here. Nothing changed.',
  location_not_found: 'That filament or place is not recognised here. Nothing changed.',
};

const filamentLabel = (f) => `${f.manufacturer} ${f.type} ${f.color}`;

function isFilament(f) {
  return (
    f !== null &&
    typeof f === 'object' &&
    typeof f.id === 'string' &&
    typeof f.manufacturer === 'string' &&
    typeof f.type === 'string' &&
    typeof f.color === 'string' &&
    (f.spool_kind === 'refillable' || f.spool_kind === 'disposable')
  );
}

function isLine(l) {
  return (
    l !== null &&
    typeof l === 'object' &&
    typeof l.id === 'string' &&
    typeof l.location_id === 'string' &&
    (l.pack === 'spool' || l.pack === 'refill') &&
    Number.isInteger(l.count) &&
    isFilament(l.filament)
  );
}

function el(tag, text, attrs = {}) {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function fillSelect(select, values, placeholder) {
  select.replaceChildren();
  if (placeholder) select.append(el('option', placeholder, { value: '' }));
  for (const v of values) select.append(el('option', v.label, { value: v.value }));
}

let controller = null;

export async function setupStock(nodes, onError, onChanged) {
  const $ = (id) => {
    const e = document.getElementById(id);
    if (!e) throw new Error(`missing #${id}`);
    return e;
  };
  const section = $('stock-section');
  const place = $('stock-place');
  const list = $('stock-lines');
  const status = $('stock-status');
  const warning = $('stock-warning');
  const anyway = $('stock-anyway');
  const mfr = $('add-mfr');
  const type = $('add-type');
  const color = $('add-color');
  const pack = $('add-pack');
  const addGo = $('add-go');
  const whereFilament = $('where-filament');
  const whereList = $('where-lines');

  controller?.abort();
  controller = new AbortController();
  const { signal } = controller;

  // Boxed counts go on shelves and drawers, not in rooms or loaded slots.
  const slotIds = new Set();
  const walk = (ns) => {
    for (const n of ns) {
      if (n.leaf && n.type === 'active_use') slotIds.add(n.id);
      walk(n.children);
    }
  };
  walk(nodes);
  const places = leafPaths(nodes).filter((p) => !slotIds.has(p.id));
  const labels = new Map(places.map((p) => [p.id, p.label]));
  if (places.length === 0) {
    section.hidden = true;
    return;
  }
  fillSelect(
    place,
    places.map((p) => ({ value: p.id, label: p.label })),
  );

  const data = await getJson('/api/v1/filaments');
  if (!data || !Array.isArray(data.filaments) || !data.filaments.every(isFilament)) {
    throw new Error('unexpected data');
  }
  const filaments = data.filaments;
  const empty = filaments.length === 0;
  for (const id of ['stock-add', 'stock-where']) {
    const e = document.getElementById(id);
    if (e) e.hidden = empty;
  }
  $('stock-empty').hidden = !empty;

  let busy = false;
  let pending = null;
  // Cleared first, so the same message twice in a row is announced twice.
  const say = (text) => {
    status.textContent = '';
    if (text !== '') {
      requestAnimationFrame(() => {
        status.textContent = text;
      });
    }
  };
  status.tabIndex = -1;
  const clearWarning = () => {
    pending = null;
    warning.textContent = '';
    anyway.hidden = true;
  };

  async function guarded(fn) {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (error) {
      if (error instanceof ApiError && error.status !== 401) {
        say(
          REFUSALS[error.body?.error] ??
            `The server could not do that (HTTP ${String(error.status)}).`,
        );
      } else {
        onError(error);
      }
    } finally {
      busy = false;
    }
  }

  function renderLine(line) {
    const li = el('li');
    li.dataset.id = line.id;
    const name = `${filamentLabel(line.filament)}, ${PACK[line.pack].toLowerCase()}`;
    const text = el('span', `${filamentLabel(line.filament)} · ${PACK[line.pack]}`);
    const group = el('span', '', { role: 'group', 'aria-label': `Count for ${name}` });
    group.className = 'counter';
    // The accessible name starts with the visible symbol's word (WCAG 2.5.3), then says what it does.
    const less = el('button', '−', { type: 'button', 'aria-label': `Minus: one fewer, ${name}` });
    // Not a live region of its own: the status line announces the new count once.
    const count = el('output', String(line.count), {
      'aria-live': 'off',
      'aria-label': `Count, ${name}`,
    });
    const more = el('button', '+', { type: 'button', 'aria-label': `Plus: one more, ${name}` });
    const sync = (n) => {
      count.textContent = String(n);
      less.setAttribute('aria-disabled', String(n <= 0));
    };
    sync(line.count);
    const tap = (delta, confirm = false) =>
      guarded(async () => {
        const body = {
          filament_id: line.filament.id,
          location_id: line.location_id,
          pack: line.pack,
          delta,
          confirm,
        };
        clearWarning();
        try {
          const result = await postJson('/api/v1/stock/adjust', body);
          if (!isLine(result.line)) throw new Error('unexpected data');
          sync(result.line.count);
          say(`${name}: now ${String(result.line.count)}.`);
          void onChanged();
          showWhere().catch(onError);
        } catch (error) {
          if (
            error instanceof ApiError &&
            error.status === 409 &&
            error.body?.error === 'needs_confirmation'
          ) {
            askAnyway(body, name);
            return;
          }
          throw error;
        }
      });
    less.addEventListener('click', () => {
      if (less.getAttribute('aria-disabled') === 'true') {
        say(REFUSALS.below_zero);
        return;
      }
      void tap(-1);
    });
    more.addEventListener('click', () => void tap(1));
    group.append(less, count, more);
    li.append(text, group);
    return li;
  }

  function askAnyway(body, name) {
    pending = { body, name };
    warning.textContent = `Warning: adding ${name} goes over this place's hard limit. Nothing was added yet.`;
    anyway.hidden = false;
    anyway.focus();
  }

  let placeSeq = 0;
  async function showPlace() {
    placeSeq += 1;
    const mine = placeSeq;
    const id = place.value;
    const result = await getJson(`/api/v1/locations/${encodeURIComponent(id)}/stock`);
    if (!result || !Array.isArray(result.lines) || !result.lines.every(isLine)) {
      throw new Error('unexpected data');
    }
    if (mine !== placeSeq || signal.aborted) return; // a newer choice or load has taken over
    list.replaceChildren(...result.lines.map(renderLine));
    if (result.lines.length === 0) list.append(el('li', 'Nothing boxed here yet.'));
  }

  // ---- add a filament by choosing, never typing
  const byMfr = [...new Set(filaments.map((f) => f.manufacturer))];
  fillSelect(
    mfr,
    byMfr.map((m) => ({ value: m, label: m })),
    'Choose a manufacturer',
  );
  const typesFor = (m) => [
    ...new Set(filaments.filter((f) => f.manufacturer === m).map((f) => f.type)),
  ];
  const colorsFor = (m, t) => filaments.filter((f) => f.manufacturer === m && f.type === t);
  const chosen = () => filaments.find((f) => f.id === color.value);
  const syncAdd = () => {
    const f = chosen();
    const keep = pack.value;
    // Refill is offered only when it would be accepted.
    pack.replaceChildren(
      el('option', 'Spool', { value: 'spool' }),
      el(
        'option',
        f && f.spool_kind === 'refillable'
          ? 'Refill pack'
          : 'Refill pack (refillable filaments only)',
        {
          value: 'refill',
          ...(f && f.spool_kind === 'refillable' ? {} : { disabled: '' }),
        },
      ),
    );
    if (keep === 'refill' && f && f.spool_kind === 'refillable') pack.value = 'refill';
    addGo.setAttribute('aria-disabled', String(!f));
  };
  mfr.addEventListener(
    'change',
    () => {
      fillSelect(
        type,
        typesFor(mfr.value).map((t) => ({ value: t, label: t })),
        'Choose a type',
      );
      fillSelect(color, [], 'Choose a color');
      syncAdd();
    },
    { signal },
  );
  type.addEventListener(
    'change',
    () => {
      fillSelect(
        color,
        colorsFor(mfr.value, type.value).map((f) => ({ value: f.id, label: f.color })),
        'Choose a color',
      );
      syncAdd();
    },
    { signal },
  );
  color.addEventListener('change', syncAdd, { signal });
  fillSelect(type, [], 'Choose a type');
  fillSelect(color, [], 'Choose a color');
  syncAdd();
  addGo.addEventListener(
    'click',
    () => {
      const f = chosen();
      if (!f) {
        say('Choose a manufacturer, type and color first.');
        return;
      }
      void guarded(async () => {
        clearWarning();
        const body = {
          filament_id: f.id,
          location_id: place.value,
          pack: pack.value,
          delta: 1,
          confirm: false,
        };
        const name = `${filamentLabel(f)}, ${pack.value}`;
        try {
          const result = await postJson('/api/v1/stock/adjust', body);
          if (!isLine(result.line)) throw new Error('unexpected data');
          say(
            `Added ${name}: now ${String(result.line.count)} at ${labels.get(place.value) ?? 'this place'}.`,
          );
          await showPlace();
          void onChanged();
        } catch (error) {
          if (
            error instanceof ApiError &&
            error.status === 409 &&
            error.body?.error === 'needs_confirmation'
          ) {
            askAnyway(body, name);
            return;
          }
          throw error;
        }
      });
    },
    { signal },
  );
  anyway.addEventListener(
    'click',
    () => {
      const p = pending;
      if (!p || p.body.location_id !== place.value) return;
      void guarded(async () => {
        const result = await postJson('/api/v1/stock/adjust', { ...p.body, confirm: true });
        if (!isLine(result.line)) throw new Error('unexpected data');
        clearWarning();
        say(`${p.name}: now ${String(result.line.count)} (over the limit, as you confirmed).`);
        await showPlace();
        void onChanged();
        showWhere().catch(onError);
        status.focus();
      });
    },
    { signal },
  );
  place.addEventListener(
    'change',
    () => {
      clearWarning();
      say('');
      // Reading is never blocked by a write in flight; the newest choice wins.
      showPlace().catch((error) => {
        onError(error);
      });
    },
    { signal },
  );

  // ---- where is it?
  fillSelect(
    whereFilament,
    filaments.map((f) => ({ value: f.id, label: filamentLabel(f) })),
    'Choose a filament',
  );
  let whereSeq = 0;
  async function showWhere() {
    whereSeq += 1;
    const mine = whereSeq;
    const id = whereFilament.value;
    if (id === '') {
      whereList.replaceChildren();
      return;
    }
    const result = await getJson(`/api/v1/filaments/${encodeURIComponent(id)}/stock`);
    if (!result || !Array.isArray(result.lines) || !result.lines.every(isLine)) {
      throw new Error('unexpected data');
    }
    if (mine !== whereSeq || signal.aborted) return; // a newer choice has taken over
    const items = result.lines.map((l) =>
      el(
        'li',
        `${labels.get(l.location_id) ?? l.location_id}: ${String(l.count)} ${PACK[l.pack].toLowerCase()}${l.count === 1 ? '' : 's'}`,
      ),
    );
    whereList.replaceChildren(...(items.length > 0 ? items : [el('li', 'None boxed anywhere.')]));
  }
  whereFilament.addEventListener(
    'change',
    () => {
      whereList.replaceChildren();
      showWhere().catch((error) => {
        if (error instanceof ApiError && error.status !== 401) {
          say(`The server could not do that (HTTP ${String(error.status)}).`);
        } else {
          onError(error);
        }
      });
    },
    { signal },
  );

  clearWarning();
  say('');
  section.hidden = false;
  await showPlace();
}
