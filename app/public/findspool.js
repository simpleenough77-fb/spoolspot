// SPDX-License-Identifier: AGPL-3.0-or-later
// Find a spool (SPOOL-211): the non-NFC way to learn where a spool belongs. Choose its filament by
// manufacturer, type and color (taps only, as on the boxed stock section), see that filament's clips,
// tap one to get the clip tag page's view: where it belongs, the chain of containers above that place,
// and Move this clip through the shared mover. Wording comes from tapview.js and mover.js, so it is
// the tag page's. Every value goes in with textContent; every name sits in its own <bdi>.
// The card is never drawn from an old list: a tap on a clip, Move this clip and a refused move each
// re-read the filament's clips first (the same GET), and main.js re-reads them after any move on the
// page. Only the newest request may draw: an older answer is dropped.
import { ApiError, getJson } from './api.js';
import { clipLabel, createMoverPanel, holdClip, refusalMessage, stateLabel } from './mover.js';
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
    : placeLabel === undefined
      ? [`${lead}, at ${PLACE_NOT_LISTED}`]
      : [`${lead}, at `, name(placeLabel)];
}

export const GONE = 'That clip is no longer recorded here.';
/** A list row whose place is missing from this page's tree: never a raw id on screen. */
export const PLACE_NOT_LISTED = 'a place not in this page’s list of places';
/** Said instead of a place when the clip's place is missing from this page's tree. */
export const PLACE_NOT_LOADED =
  'The place recorded for this clip is not in this page’s list of places. Reload the page to see it.';

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
let active = null;

/**
 * After any move on the main page (main.js reloadTree): take the fresh tree and, when a filament is
 * chosen, re-read its clips and redraw the open card. No request when no filament is chosen.
 */
export async function refreshFind(nodes) {
  await active?.(nodes);
}

export async function setupFind(initialNodes, onError, onChanged) {
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
  const listHeading = $('find-clips-heading');
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
  active = null;

  let nodes = initialNodes;
  let labels = new Map();
  const takeTree = (next) => {
    nodes = next;
    labels = new Map(leafPaths(nodes).map((p) => [p.id, p.label]));
  };
  takeTree(initialNodes);

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
  // A clip tapped whose answer has not been drawn yet; a refresh that supersedes the tap opens it.
  let pendingOpen = null;
  // Set while this section's own move reloads the page, so a clip gone after it is said here.
  let ownMove = false;
  /** Whether the card for clip `id` is still the one open (the person did not go Back meanwhile). */
  const stillOpen = (id) => id !== undefined && !card.hidden && shown?.id === id;

  const mover = createMoverPanel(
    leafPaths(initialNodes),
    (result) => {
      // The mover said "Moved." in its own panel; close it, let the page reload (which re-reads this
      // filament's clips and redraws the card), then say where the clip is now, once.
      mover.element.hidden = true;
      ownMove = true;
      void Promise.resolve(onChanged()).then(() => {
        ownMove = false;
        if (!stillOpen(result.clip.id)) return;
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
      headingText: 'Move this clip',
      onClose: () => {
        pickUp.focus();
      },
      onRefused: (error) => {
        const code = error instanceof ApiError ? error.body?.error : undefined;
        if (code !== 'not_found' && code !== 'location_not_found' && code !== 'conflict') return;
        // The clip or a place changed: re-read, keep the mover and its refusal on screen.
        const id = shown?.id;
        void load().then((ok) => {
          // Back (or anything else) since the refusal: draw nothing.
          if (ok !== true || !stillOpen(id)) return;
          const fresh = clips.find((c) => c.id === id);
          if (fresh) {
            showCard(fresh, { keepMover: true });
          } else {
            gone([refusalMessage(error), ' ', GONE]);
          }
        });
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

  function closeCard() {
    // Closing the card invalidates every answer still in flight for it.
    sequence += 1;
    card.hidden = true;
    mover.element.hidden = true;
    shown = null;
  }

  /** The clip tag page's view of `clip`, which must come from the newest answer. */
  function showCard(clip, { keepMover = false } = {}) {
    shown = clip;
    const label = clipLabel(clip);
    const path = pathTo(nodes, clip.location_id);
    const text = clipCardText(label, stateLabel(clip.state), path);
    // A place the page's tree does not have yet: never say "no place" for a clip that has one.
    const place = clip.location_id !== null && path.length === 0 ? [PLACE_NOT_LOADED] : text.place;
    heading.replaceChildren(...partNodes(text.heading));
    detail.textContent = text.detail;
    body.replaceChildren(
      el('h4', text.belongsHeading),
      sentence('p', place, { id: 'find-clip-place' }),
      ...pathBlock(path, text.pathLead),
    );
    if (!keepMover) mover.element.hidden = true;
    listBlock.hidden = true;
    card.hidden = false;
  }

  /** The clip is not in the newest answer: back to the list, said once, focus on the list heading. */
  function gone(parts = [GONE]) {
    closeCard();
    listBlock.hidden = false;
    say(parts);
    listHeading.focus();
  }

  function renderList() {
    const focusedClip = document.activeElement?.getAttribute('data-clip') ?? null;
    list.replaceChildren();
    clips.forEach((c, i) => {
      const li = el('li');
      const button = el('button', '', { type: 'button', 'data-clip': c.id });
      button.replaceChildren(...partNodes(clipItemParts(c, i, labels.get(c.location_id ?? ''))));
      button.addEventListener('click', () => {
        void openClip(c.id);
      });
      li.append(button);
      list.append(li);
    });
    if (clips.length === 0) list.append(el('li', 'No clips of this filament are recorded.'));
    // A refresh must not drop focus that was on a clip's button.
    if (focusedClip !== null) {
      [...list.querySelectorAll('button')]
        .find((b) => b.getAttribute('data-clip') === focusedClip)
        ?.focus();
    }
  }

  const chosen = () => filaments.find((f) => f.id === color.value);

  /**
   * Re-reads the chosen filament's clips and redraws the list. Resolves true when this answer is the
   * newest one and was drawn; null when a newer request (or closing the card) took over; false when
   * no filament is chosen or it failed (the failure is said on the status line).
   */
  async function load() {
    sequence += 1;
    const mine = sequence;
    const f = chosen();
    if (!f) return false;
    try {
      const result = await getJson(`/api/v1/filaments/${encodeURIComponent(f.id)}/clips`);
      if (!result || !Array.isArray(result.clips) || !result.clips.every(isClip)) {
        throw new Error('unexpected data');
      }
      if (mine !== sequence || signal.aborted) return null; // a newer request has taken over
      clips = result.clips;
      renderList();
      return true;
    } catch (error) {
      if (mine !== sequence || signal.aborted) return null;
      if (error instanceof ApiError && error.status !== 401) {
        say([
          error.status === 404
            ? 'That filament is not recognised here.'
            : `The server could not do that (HTTP ${String(error.status)}).`,
        ]);
      } else {
        onError(error);
      }
      return false;
    }
  }

  /** A tap on a clip: re-read first, then draw the card from the fresh answer. */
  async function openClip(id) {
    say([]);
    pendingOpen = id;
    const ok = await load();
    // Superseded (null): a refresh that took over opens it; anything else cancels it.
    if (ok === false) pendingOpen = null;
    if (ok !== true || pendingOpen !== id) return;
    drawPending();
  }

  /** Opens the tapped clip from the answer just drawn, or says it is gone. */
  function drawPending() {
    const id = pendingOpen;
    pendingOpen = null;
    const fresh = clips.find((c) => c.id === id);
    if (!fresh) {
      gone();
      return;
    }
    showCard(fresh);
    heading.focus();
  }

  const reset = () => {
    sequence += 1;
    pendingOpen = null;
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
      const f = chosen();
      void load().then((ok) => {
        if (ok && f) {
          listBlock.hidden = false;
          say(listedParts(clips.length, filamentLabel(f)));
        }
      });
    },
    { signal },
  );

  pickUp.onclick = () => {
    const id = shown?.id;
    if (id === undefined) return;
    // As on the clip tag page: held for ten minutes, so tapping a place tag next offers "Move here".
    // Re-read first, so the held clip carries its place as it is now.
    void load().then((ok) => {
      // Back since the tap: hold nothing, open nothing.
      if (ok !== true || !stillOpen(id)) return;
      const fresh = clips.find((c) => c.id === id);
      if (!fresh) {
        gone();
        return;
      }
      showCard(fresh);
      const held = { id: fresh.id, label: clipLabel(fresh) };
      holdClip(held.id, held.label, fresh.location_id);
      say(['Held for ten minutes. Tap a place tag, or choose a place below.']);
      mover.show(held, fresh.location_id ?? undefined);
    });
  };
  back.onclick = () => {
    const was = shown;
    closeCard();
    listBlock.hidden = false;
    say([]);
    const button = [...list.querySelectorAll('button')].find(
      (b) => b.getAttribute('data-clip') === was?.id,
    );
    (button ?? listHeading).focus();
  };

  active = async (next) => {
    takeTree(next);
    if (!chosen()) return; // nothing chosen: no request
    const openId = card.hidden ? undefined : shown?.id;
    const moverOpen = !mover.element.hidden;
    if ((await load()) !== true) return;
    if (pendingOpen !== null) {
      // A tap this refresh superseded: open it now, as the tap would have.
      drawPending();
      return;
    }
    if (openId === undefined || !stillOpen(openId)) return; // no card, or Back meanwhile
    const fresh = clips.find((c) => c.id === openId);
    if (fresh) {
      showCard(fresh, { keepMover: moverOpen });
    } else if (ownMove || section.contains(document.activeElement)) {
      gone();
    } else {
      // Someone working in another section: close the card quietly, say nothing, keep their focus.
      closeCard();
      listBlock.hidden = false;
    }
  };

  reset();
  section.hidden = false;
}
