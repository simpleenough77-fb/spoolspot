// SPDX-License-Identifier: AGPL-3.0-or-later
// Find a spool (SPOOL-211): the non-NFC way to learn where a spool belongs. Choose its filament by
// manufacturer, type and color (taps only, as on the boxed stock section), see that filament's clips,
// tap one to get the clip tag page's view: where it belongs, the chain of containers above that place,
// and Move this clip through the shared mover. Wording comes from tapview.js and mover.js, so it is
// the tag page's. Every value goes in with textContent; every name sits in its own <bdi>.
import { ApiError, getJson } from './api.js';
import { clipLabel, createMoverPanel, holdClip, stateLabel } from './mover.js';
import { filamentLabel, isFilament } from './stock.js';
import { clipCardText, movedText, name, pathTo } from './tapview.js';
import { leafPaths } from './tree.js';

/** The list's bound (the API returns at most this many clips of one filament). */
export const LIST_BOUND = 200;

/**
 * One clip in the list, as parts (see tapview.js): its number in the list, its state and its place.
 * The number tells apart two clips with the same state at the same place.
 */
export function clipItemParts(clip, index, placeLabel) {
  const lead = `Clip ${String(index + 1)}: ${stateLabel(clip.state)}`;
  return clip.location_id === null
    ? [`${lead}, no place recorded`]
    : [`${lead}, at `, name(placeLabel ?? clip.location_id)];
}

/** What the status line says once a filament's clips are listed. */
export function listedParts(count, label) {
  if (count === 0) return ['No clips of ', name(label), ' are recorded.'];
  const more =
    count >= LIST_BOUND ? ` Showing the first ${String(LIST_BOUND)}; there may be more.` : '';
  return [`${String(count)} clip${count === 1 ? '' : 's'} of `, name(label), `.${more}`];
}

function isClip(c) {
  return (
    c !== null &&
    typeof c === 'object' &&
    typeof c.id === 'string' &&
    typeof c.state === 'string' &&
    (c.location_id === null || typeof c.location_id === 'string') &&
    typeof c.filament?.manufacturer === 'string' &&
    typeof c.filament.type === 'string' &&
    typeof c.filament.color === 'string'
  );
}

function el(tag, text, attrs = {}) {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

/** Parts as DOM nodes: plain words as text, every name in its own <bdi>. */
function partNodes(parts) {
  return parts.map((p) => {
    if (typeof p === 'string') return document.createTextNode(p);
    const b = document.createElement('bdi');
    b.textContent = p.name;
    return b;
  });
}

function sentence(tag, parts, attrs = {}) {
  const e = el(tag, '', attrs);
  e.replaceChildren(...partNodes(parts));
  return e;
}

function fillSelect(select, values, placeholder) {
  select.replaceChildren(el('option', placeholder, { value: '' }));
  for (const v of values) select.append(el('option', v.label, { value: v.value }));
}

let controller = null;

export async function setupFind(nodes, onError, onChanged) {
  const $ = (id) => {
    const e = document.getElementById(id);
    if (!e) throw new Error(`missing #${id}`);
    return e;
  };
  const section = $('find-section');
  const chooser = $('find-filament');
  const mfr = $('find-mfr');
  const type = $('find-type');
  const color = $('find-color');
  const status = $('find-status');
  const listBlock = $('find-list');
  const list = $('find-clips');
  const card = $('find-clip');
  const heading = $('find-clip-heading');
  const detail = $('find-clip-detail');
  const body = $('find-clip-body');
  const pickUp = $('find-pick-up');
  const back = $('find-back');
  const moverSlot = $('find-mover');

  controller?.abort();
  controller = new AbortController();
  const { signal } = controller;

  const leaves = leafPaths(nodes);
  const labels = new Map(leaves.map((p) => [p.id, p.label]));

  const data = await getJson('/api/v1/filaments');
  if (!data || !Array.isArray(data.filaments) || !data.filaments.every(isFilament)) {
    throw new Error('unexpected data');
  }
  const filaments = data.filaments;
  $('find-empty').hidden = filaments.length > 0;
  chooser.hidden = filaments.length === 0;

  // Cleared first, so the same message twice in a row is announced again; each is set once.
  const say = (parts) => {
    status.replaceChildren();
    if (parts.length > 0) {
      requestAnimationFrame(() => {
        status.replaceChildren(...partNodes(parts));
      });
    }
  };

  let clips = [];
  let shown = null;
  let sequence = 0;

  const closeCard = () => {
    card.hidden = true;
    mover.element.hidden = true;
    shown = null;
  };

  const mover = createMoverPanel(
    leaves,
    (result) => {
      // The mover said "Moved." in its own panel; close it and say where the clip is now, once.
      mover.element.hidden = true;
      void onChanged();
      void loadClips({ keepCard: result.clip.id }).then(() => {
        say(
          result.moved
            ? movedText(clipLabel(result.clip), pathTo(nodes, result.clip.location_id))
            : ['It is already there. Nothing changed.'],
        );
        heading.focus();
      });
    },
    {
      idPrefix: 'find-',
      headingTag: 'h3',
      onClose: () => {
        pickUp.focus();
      },
    },
  );
  moverSlot.replaceChildren(mover.element);

  const pathBlock = (path, lead) => {
    if (path.length === 0) return [];
    const intro = el('p', lead, { id: 'find-path-lead', class: 'path-lead' });
    const ol = el('ol', '', { class: 'path', 'aria-labelledby': 'find-path-lead' });
    path.forEach((p, i) => {
      const li = sentence('li', [name(p.name)]);
      if (i === path.length - 1) li.setAttribute('aria-current', 'location');
      ol.append(li);
    });
    return [intro, ol];
  };

  function showCard(clip) {
    shown = clip;
    const label = clipLabel(clip);
    const path = pathTo(nodes, clip.location_id);
    const text = clipCardText(label, stateLabel(clip.state), path);
    heading.replaceChildren(...partNodes(text.heading));
    detail.textContent = text.detail;
    body.replaceChildren(
      el('h4', text.belongsHeading),
      sentence('p', text.place, { id: 'find-clip-place' }),
      ...pathBlock(path, text.pathLead),
    );
    mover.element.hidden = true;
    listBlock.hidden = true;
    card.hidden = false;
  }

  function renderList(label) {
    list.replaceChildren();
    clips.forEach((c, i) => {
      const li = el('li');
      const button = el('button', '', { type: 'button', 'data-clip': c.id });
      button.replaceChildren(...partNodes(clipItemParts(c, i, labels.get(c.location_id ?? ''))));
      button.addEventListener('click', () => {
        say([]);
        showCard(c);
        heading.focus();
      });
      li.append(button);
      list.append(li);
    });
    if (clips.length === 0) list.append(el('li', 'No clips of this filament are recorded.'));
    listBlock.hidden = false;
    return listedParts(clips.length, label);
  }

  const chosen = () => filaments.find((f) => f.id === color.value);

  /** Loads the chosen filament's clips. `keepCard`: after a move, show that clip's view again. */
  async function loadClips({ keepCard = null } = {}) {
    sequence += 1;
    const mine = sequence;
    const f = chosen();
    if (!f) return;
    try {
      const result = await getJson(`/api/v1/filaments/${encodeURIComponent(f.id)}/clips`);
      if (!result || !Array.isArray(result.clips) || !result.clips.every(isClip)) {
        throw new Error('unexpected data');
      }
      if (mine !== sequence || signal.aborted) return; // a newer choice has taken over
      clips = result.clips;
      const listed = renderList(filamentLabel(f));
      const again = keepCard === null ? undefined : clips.find((c) => c.id === keepCard);
      if (again) {
        showCard(again);
      } else {
        say(listed);
      }
    } catch (error) {
      if (mine !== sequence) return;
      if (error instanceof ApiError && error.status !== 401) {
        say([
          error.status === 404
            ? 'That filament is not recognised here.'
            : `The server could not do that (HTTP ${String(error.status)}).`,
        ]);
      } else {
        onError(error);
      }
    }
  }

  const reset = () => {
    sequence += 1;
    closeCard();
    listBlock.hidden = true;
    list.replaceChildren();
    clips = [];
    say([]);
  };

  // ---- choose the filament by tapping: manufacturer, type, color (as on the boxed stock section)
  fillSelect(
    mfr,
    [...new Set(filaments.map((f) => f.manufacturer))].map((m) => ({ value: m, label: m })),
    'Choose a manufacturer',
  );
  fillSelect(type, [], 'Choose a type');
  fillSelect(color, [], 'Choose a color');
  mfr.addEventListener(
    'change',
    () => {
      const types = [
        ...new Set(filaments.filter((f) => f.manufacturer === mfr.value).map((f) => f.type)),
      ];
      fillSelect(
        type,
        types.map((t) => ({ value: t, label: t })),
        'Choose a type',
      );
      fillSelect(color, [], 'Choose a color');
      reset();
    },
    { signal },
  );
  type.addEventListener(
    'change',
    () => {
      fillSelect(
        color,
        filaments
          .filter((f) => f.manufacturer === mfr.value && f.type === type.value)
          .map((f) => ({ value: f.id, label: f.color })),
        'Choose a color',
      );
      reset();
    },
    { signal },
  );
  color.addEventListener(
    'change',
    () => {
      reset();
      void loadClips();
    },
    { signal },
  );

  pickUp.onclick = () => {
    if (!shown) return;
    const held = { id: shown.id, label: clipLabel(shown) };
    // As on the clip tag page: held for ten minutes, so tapping a place tag next offers "Move here".
    holdClip(held.id, held.label, shown.location_id);
    say(['Held for ten minutes. Tap a place tag, or choose a place below.']);
    mover.show(held, shown.location_id ?? undefined);
  };
  back.onclick = () => {
    const was = shown;
    closeCard();
    listBlock.hidden = false;
    say([]);
    const button = [...list.querySelectorAll('button')].find(
      (b) => b.getAttribute('data-clip') === was?.id,
    );
    (button ?? $('find-clips-heading')).focus();
  };

  reset();
  section.hidden = false;
}
