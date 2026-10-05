// SPDX-License-Identifier: AGPL-3.0-or-later
// Moving a clip: shared by the tap page and the main page. Only taps; nothing is typed. A move is never
// made by a bare tap on a tag: the person confirms on screen. Past a hard limit the server asks for a
// second, explicit "Move anyway". Every value goes in with textContent.
import { ApiError, getJson, postJson } from './api.js';

const HOLD_KEY = 'spoolspot.held-clip';
const HOLD_MINUTES = 10;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The held clip is a non-secret id and a time, so it may live in localStorage and survive the next tap. */
export function holdClip(id, label) {
  try {
    localStorage.setItem(
      HOLD_KEY,
      JSON.stringify({ id, label: String(label).slice(0, 120), at: Date.now() }),
    );
  } catch {
    /* storage blocked: the picker below still works */
  }
}

export function heldClip() {
  try {
    const raw = JSON.parse(localStorage.getItem(HOLD_KEY) ?? 'null');
    if (
      raw !== null &&
      typeof raw.id === 'string' &&
      ID.test(raw.id) &&
      typeof raw.label === 'string' &&
      Number.isFinite(raw.at) &&
      Date.now() - raw.at < HOLD_MINUTES * 60_000 &&
      Date.now() >= raw.at
    ) {
      return { id: raw.id, label: raw.label };
    }
    localStorage.removeItem(HOLD_KEY);
  } catch {
    /* ignore */
  }
  return null;
}

export function dropHeldClip() {
  try {
    localStorage.removeItem(HOLD_KEY);
  } catch {
    /* ignore */
  }
}

export const clipLabel = (clip) =>
  `${clip.filament.manufacturer} ${clip.filament.type} ${clip.filament.color}`;

const STATE = { on_spool: 'on a spool', spool_empty: 'spool empty', free: 'free (no spool)' };
export const stateLabel = (state) => STATE[state] ?? state;

/** Plain-language outcome of a refused or failed move. */
export function refusalMessage(error) {
  if (!(error instanceof ApiError)) return 'Could not reach the server. Nothing was moved.';
  const code = error.body?.error;
  if (error.status === 401) return 'Your session ended. Sign in again. Nothing was moved.';
  if (code === 'not_a_leaf')
    return 'Choose a shelf or drawer, not a whole room. Nothing was moved.';
  if (code === 'slot_not_supported')
    return 'Loading and unloading a slot is not available here yet. Nothing was moved.';
  if (code === 'conflict')
    return 'That changed while you were looking. Nothing was moved; try again.';
  if (code === 'not_found' || code === 'location_not_found')
    return 'That clip or place is not recognised here. Nothing was moved.';
  return `The server could not move it (HTTP ${String(error.status)}). Nothing was moved.`;
}

/**
 * Moves a clip, with the confirm step. `ui` is { status, warning, confirmButton } elements. Resolves to
 * the move result, or null when the person has to confirm first or the move was refused.
 */
export async function requestMove(clipId, to, confirm, ui) {
  ui.status.textContent = 'Moving…';
  ui.warning.textContent = '';
  ui.confirmButton.hidden = true;
  try {
    const result = await postJson(`/api/v1/clips/${clipId}/move`, { to, confirm });
    ui.status.textContent = result.moved ? 'Moved.' : 'It is already there. Nothing changed.';
    return result;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401 && ui.onUnauthorized) {
      ui.onUnauthorized();
      return null;
    }
    if (
      error instanceof ApiError &&
      error.status === 409 &&
      error.body?.error === 'needs_confirmation'
    ) {
      const check = error.body.check;
      const over =
        check && Number.isInteger(check.free_after) ? Math.max(0, -check.free_after) : null;
      ui.status.textContent = '';
      ui.warning.textContent =
        over === null
          ? 'Warning: this place is at its hard limit.'
          : `Warning: this goes ${String(over)} over the hard limit.`;
      ui.confirmButton.hidden = false;
      ui.confirmButton.focus();
      return null;
    }
    ui.status.textContent = refusalMessage(error);
    return null;
  }
}

/** Fills a <select> with the places that hold units, grouped by path. `leaves` come from leafPaths(). */
export function fillPlacePicker(select, leaves) {
  select.replaceChildren();
  for (const leaf of leaves) {
    const option = document.createElement('option');
    option.value = leaf.id;
    option.textContent = leaf.label;
    select.append(option);
  }
}

export async function loadClipsAt(locationId) {
  const data = await getJson(`/api/v1/locations/${encodeURIComponent(locationId)}/clips`);
  if (!data || !Array.isArray(data.clips)) throw new Error('unexpected data');
  return data.clips;
}

function el(tag, text, attrs = {}) {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

/**
 * The mover panel: shows the chosen clip, a place picker (the non-NFC way to choose a destination), a
 * "Move" button, and the hard-limit warning with "Move anyway". Returns { element, show(clip, placeId) }.
 * `leaves` come from leafPaths(). `onMoved(result)` runs after a successful move.
 */
export function createMoverPanel(leaves, onMoved, hooks = {}) {
  const panel = el('section', '', { 'aria-labelledby': 'mover-heading' });
  panel.hidden = true;
  const heading = el('h2', 'Move a clip', { id: 'mover-heading', tabindex: '-1' });
  const which = el('p', '', { id: 'mover-clip' });
  const pickLabel = el('label', 'Move it to', { for: 'mover-place' });
  const select = el('select', '', { id: 'mover-place' });
  fillPlacePicker(select, leaves);
  const move = el('button', 'Move here', { type: 'button', id: 'mover-go' });
  const status = el('p', '', { id: 'mover-status', role: 'status' });
  const warning = el('p', '', { id: 'mover-warning', role: 'alert' });
  const anyway = el('button', 'Move anyway', { type: 'button', id: 'mover-anyway' });
  anyway.hidden = true;
  const cancel = el('button', 'Cancel', { type: 'button', id: 'mover-cancel', class: 'secondary' });
  panel.append(heading, which, pickLabel, select, move, warning, anyway, status, cancel);
  let clip = null;
  let busy = false;
  let pendingTo = null;

  const run = async (confirm) => {
    if (clip === null || busy) return;
    // Confirming applies only to the place the warning was about.
    if (confirm && pendingTo !== select.value) return;
    busy = true;
    select.disabled = true;
    move.setAttribute('aria-disabled', 'true');
    anyway.setAttribute('aria-disabled', 'true');
    try {
      const result = await requestMove(clip.id, select.value, confirm, {
        status,
        warning,
        confirmButton: anyway,
        onUnauthorized: hooks.onUnauthorized,
      });
      pendingTo = anyway.hidden ? null : select.value;
      if (result) {
        dropHeldClip();
        move.hidden = true;
        cancel.textContent = 'Done';
        onMoved(result);
      }
    } finally {
      busy = false;
      select.disabled = false;
      move.removeAttribute('aria-disabled');
      anyway.removeAttribute('aria-disabled');
    }
  };
  move.addEventListener('click', () => void run(false));
  anyway.addEventListener('click', () => void run(true));
  cancel.addEventListener('click', () => {
    dropHeldClip();
    clip = null;
    panel.hidden = true;
    hooks.onClose?.();
  });
  // A different place after a warning means the warning no longer applies.
  select.addEventListener('change', () => {
    warning.textContent = '';
    pendingTo = null;
    anyway.hidden = true;
    status.textContent = '';
  });

  return {
    element: panel,
    show(next, placeId) {
      clip = next;
      which.textContent = `Clip: ${next.label}`;
      if (placeId && [...select.options].some((o) => o.value === placeId)) select.value = placeId;
      status.textContent = '';
      warning.textContent = '';
      pendingTo = null;
      anyway.hidden = true;
      move.hidden = false;
      cancel.textContent = 'Cancel';
      panel.hidden = false;
      heading.focus();
    },
  };
}
