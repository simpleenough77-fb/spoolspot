// SPDX-License-Identifier: AGPL-3.0-or-later
// The page a tag opens (SPOOL-45). The server sends this same page for every tag of this instance, so it
// holds no data: it signs in (token traded for an HttpOnly cookie), asks the API what the tag stands for,
// and shows it. An unknown, malformed or other-tenant tag all end in the same neutral message.
// A clip tag: "Move this clip" holds it for ten minutes. A place tag: "Move <held clip> here". Both end
// on an on-screen confirm; nothing moves on a bare tap. A place picker is the non-NFC way to the same move.
import { ApiError, getJson, signIn } from './api.js';
import {
  clipLabel,
  createMoverPanel,
  heldClip,
  holdClip,
  loadClipsAt,
  refusalMessage,
  stateLabel,
} from './mover.js';
import { leafPaths } from './tree.js';

const NEUTRAL = 'This tag is not recognised here.';
// The path is "/" + 6-character instance code + 12-character tag ID; the API takes the ID.
const match = /^\/[A-Za-z0-9]{6}([A-Za-z0-9]{12})\/?$/.exec(location.pathname);
const tagId = match ? match[1].toUpperCase() : '';

const $ = (id) => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e;
};
const status = $('tap-status');
const signin = $('signin');
const card = $('tag-card');
const heading = $('tag-heading');
const detail = $('tag-detail');
const pickUp = $('pick-up');
const moveHeld = $('move-held-here');
const clipSection = $('clip-list-section');
const clipList = $('clip-list');

function reset() {
  signin.hidden = true;
  card.hidden = true;
  clipSection.hidden = true;
  pickUp.hidden = true;
  moveHeld.hidden = true;
  $('mover').replaceChildren();
}

function neutral() {
  reset();
  status.textContent = NEUTRAL;
}

const plural = (n, w) => `${String(n)} ${w}${n === 1 ? '' : 's'}`;

function validView(v) {
  if (v === null || typeof v !== 'object') return false;
  if (v.kind === 'clip') {
    const c = v.clip;
    return (
      c !== null &&
      typeof c === 'object' &&
      typeof c.id === 'string' &&
      typeof c.state === 'string' &&
      typeof c.location_id === 'string' &&
      typeof c.filament?.manufacturer === 'string' &&
      typeof c.filament.type === 'string' &&
      typeof c.filament.color === 'string'
    );
  }
  const l = v.location;
  return (
    v.kind === 'location' &&
    l !== null &&
    typeof l === 'object' &&
    typeof l.id === 'string' &&
    typeof l.name === 'string' &&
    typeof l.leaf === 'boolean' &&
    Number.isInteger(l.used) &&
    (l.free === null || Number.isInteger(l.free)) &&
    (l.capacity === null || Number.isInteger(l.capacity))
  );
}

function validTree(d) {
  return d !== null && typeof d === 'object' && Array.isArray(d.locations);
}

let sequence = 0;

async function show() {
  sequence += 1;
  const mine = sequence;
  reset();
  if (tagId === '') {
    neutral();
    return;
  }
  status.textContent = 'Loading…';
  let view;
  let leaves;
  try {
    view = await getJson(`/api/v1/tags/${encodeURIComponent(tagId)}`);
    const tree = await getJson('/api/v1/locations/tree');
    if (!validView(view) || !validTree(tree)) throw new Error('unexpected data');
    leaves = leafPaths(tree.locations);
  } catch (error) {
    if (mine !== sequence) return;
    if (error instanceof ApiError && error.status === 401) {
      status.textContent = 'Sign in to see this tag.';
      signin.hidden = false;
      $('token').focus();
    } else if (error instanceof ApiError && error.status === 404) {
      neutral();
    } else if (error instanceof ApiError && error.status === 429) {
      status.textContent = 'Too many requests. Wait a minute and tap again.';
    } else if (error instanceof ApiError) {
      status.textContent = `The server could not load that (HTTP ${String(error.status)}).`;
    } else if (error instanceof TypeError) {
      status.textContent = 'Could not reach the server. Check your network connection.';
    } else {
      status.textContent = 'The server sent data this page does not understand.';
    }
    return;
  }
  if (mine !== sequence) return; // a newer load has taken over
  const label = new Map(leaves.map((p) => [p.id, p.label]));
  const mover = createMoverPanel(
    leaves,
    (result) => {
      // Show the new state, then say what happened (the refresh clears the status line).
      void show().then(() => {
        if (!card.hidden) {
          status.textContent = result.moved ? 'Moved.' : 'It is already there. Nothing changed.';
          heading.focus();
        }
      });
    },
    // A session that ended mid-flow goes back to sign-in; the held clip is kept for after.
    { onUnauthorized: () => void show() },
  );
  $('mover').replaceChildren(mover.element);
  status.textContent = '';
  card.hidden = false;
  if (view.kind === 'clip') {
    const clip = { id: view.clip.id, label: clipLabel(view.clip) };
    heading.textContent = `Clip: ${clip.label}`;
    detail.textContent = `${stateLabel(view.clip.state)}. Now at ${label.get(view.clip.location_id) ?? 'a place that is not a shelf or drawer'}.`;
    pickUp.hidden = false;
    pickUp.onclick = () => {
      holdClip(clip.id, clip.label);
      status.textContent = 'Held for ten minutes. Tap a place tag, or choose a place below.';
      mover.show(clip, view.clip.location_id);
    };
    return;
  }
  const where = view.location;
  heading.textContent = where.name;
  detail.textContent =
    where.capacity === null
      ? `Capacity not set (${plural(where.used, 'item')} stored).`
      : `${where.free ?? 0} free of ${where.capacity} (${where.used} used).`;
  const held = where.leaf ? heldClip() : null;
  if (held) {
    moveHeld.hidden = false;
    moveHeld.textContent = `Move ${held.label} here`;
    moveHeld.onclick = () => {
      const still = heldClip();
      if (!still) {
        moveHeld.hidden = true;
        status.textContent = 'The held clip timed out. Tap the clip again.';
        return;
      }
      status.textContent = '';
      mover.show(still, where.id);
    };
  }
  if (where.leaf) await listClips(where.id, label, mover);
}

async function listClips(locationId, label, mover) {
  try {
    const clips = await loadClipsAt(locationId);
    clipList.replaceChildren();
    for (const c of clips) {
      const li = document.createElement('li');
      const text = document.createElement('span');
      text.textContent = `${clipLabel(c)} (${stateLabel(c.state)})`;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Move';
      button.setAttribute('aria-label', `Move ${clipLabel(c)}`);
      button.addEventListener('click', () => {
        const clip = { id: c.id, label: clipLabel(c) };
        holdClip(clip.id, clip.label);
        status.textContent = 'Held for ten minutes. Choose where it goes below.';
        mover.show(clip, locationId);
      });
      li.append(text, button);
      clipList.append(li);
    }
    if (clips.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No clips here.';
      clipList.append(li);
    }
    clipSection.hidden = false;
  } catch (error) {
    status.textContent =
      error instanceof ApiError ? refusalMessage(error) : 'Could not load the clips here.';
  }
}

signin.addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('token');
  const value = input.value.trim();
  if (value === '' || signin.querySelector('button')?.getAttribute('aria-disabled') === 'true')
    return;
  input.value = '';
  status.textContent = 'Signing in…';
  const submit = signin.querySelector('button');
  if (submit) submit.setAttribute('aria-disabled', 'true');
  signIn(value).then(
    () => {
      submit?.removeAttribute('aria-disabled');
      void show();
    },
    (error) => {
      submit?.removeAttribute('aria-disabled');
      status.textContent =
        error instanceof ApiError && error.status === 429
          ? 'Too many attempts. Wait a minute and try again.'
          : error instanceof ApiError
            ? 'That token was not accepted. Check it and try again.'
            : 'Could not reach the server. Check your network connection.';
    },
  );
});

void show();
