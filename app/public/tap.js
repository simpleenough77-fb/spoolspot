// SPDX-License-Identifier: AGPL-3.0-or-later
// The page a tag opens (SPOOL-45, SPOOL-191). The server sends this same page for every tag of this
// instance, so it holds no data: it signs in (token traded for an HttpOnly cookie), asks the API what the
// tag stands for, and shows it. An unknown, malformed, retired or other-tenant tag all end in the same
// neutral message, and nothing else is requested or shown for them.
// A clip tag says where the clip belongs (its place and the containers above it); "Move this clip" holds
// it for ten minutes. A place tag shows the place, its chain, its room and its clips; "Move <held clip>
// here". A container tag lists the places inside with their room and the API's suggested place for the
// held clip at the top. Every move ends on the shared mover's on-screen confirm; nothing moves on a bare
// tap. "Choose a place instead" reaches the same place views without a tag.
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
import {
  clipPlaceText,
  findNode,
  insideRows,
  leavesUnder,
  movedText,
  pathTo,
  roomText,
  suggestionCopy,
  takesClips,
  validView,
} from './tapview.js';
import { leafPaths, pickerNodes } from './tree.js';

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
const body = $('tag-body');
const pickUp = $('pick-up');
const moveHeld = $('move-held-here');
const clipSection = $('clip-list-section');
const clipList = $('clip-list');
const browse = $('browse');
const browsePlace = $('browse-place');

function el(tag, text, attrs = {}) {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

/** Clears the card. The place chooser stays as it is, so focus on it is never lost to a reload. */
function reset() {
  signin.hidden = true;
  card.hidden = true;
  clipSection.hidden = true;
  pickUp.hidden = true;
  moveHeld.hidden = true;
  body.replaceChildren();
  $('mover').replaceChildren();
}

/** Signed out, unknown tag or an error: nothing about any record stays on the page. */
function blank() {
  reset();
  browse.hidden = true;
  browsePlace.replaceChildren();
}

function neutral() {
  blank();
  status.textContent = NEUTRAL;
}

function validTree(d) {
  return d !== null && typeof d === 'object' && Array.isArray(d.locations);
}

let pathCount = 0;

/** "Where that is:" and the chain from Home down to the place, as an ordered list. */
function pathBlock(path, lead) {
  if (path.length === 0) return [];
  pathCount += 1;
  const id = `path-lead-${String(pathCount)}`;
  const intro = el('p', lead, { id, class: 'path-lead' });
  const list = el('ol', '', { class: 'path', 'aria-labelledby': id });
  path.forEach((p, i) => {
    const li = el('li', p.name);
    if (i === path.length - 1) li.setAttribute('aria-current', 'location');
    list.append(li);
  });
  return [intro, list];
}

// What is shown: the tag itself, or a place chosen from the list.
const TAG = { tag: true };
let subject = TAG;
let sequence = 0;

async function show(next = subject) {
  subject = next;
  sequence += 1;
  const mine = sequence;
  reset();
  if (subject === TAG && tagId === '') {
    neutral();
    return;
  }
  status.textContent = 'Loading…';
  let view = null;
  let nodes;
  // The held clip ranks a container's suggestion. It is sent for every tag alike, before the page
  // knows what the tag is, so the request never depends on the kind of tag.
  const held = heldClip();
  try {
    if (subject === TAG) {
      const query = held ? `?held=${encodeURIComponent(held.id)}` : '';
      view = await getJson(`/api/v1/tags/${encodeURIComponent(tagId)}${query}`);
      if (!validView(view)) throw new Error('unexpected data');
    }
    const tree = await getJson('/api/v1/locations/tree');
    if (!validTree(tree)) throw new Error('unexpected data');
    nodes = tree.locations;
  } catch (error) {
    if (mine !== sequence) return;
    if (error instanceof ApiError && error.status === 401) {
      blank();
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
  if (subject !== TAG) {
    const node = findNode(nodes, subject.place);
    if (!node) {
      status.textContent = 'That place is no longer in the list.';
      fillBrowse(nodes);
      return;
    }
    view = node.leaf
      ? { kind: 'location', location: node }
      : { kind: 'container', location: node, inside: leavesUnder(node), suggestion: null };
  }
  const mover = createMoverPanel(
    leafPaths(nodes),
    (result) => {
      // Show the new state, then say where the clip is now (the refresh clears the status line).
      void show().then(() => {
        if (card.hidden) return;
        status.textContent = result.moved
          ? movedText(clipLabel(result.clip), pathTo(currentNodes, result.clip.location_id))
          : 'It is already there. Nothing changed.';
        heading.focus();
      });
    },
    // A session that ended mid-flow goes back to sign-in; the held clip is kept for after.
    { onUnauthorized: () => void show() },
  );
  currentNodes = nodes;
  $('mover').replaceChildren(mover.element);
  status.textContent = '';
  card.hidden = false;
  fillBrowse(nodes);
  if (view.kind === 'clip') {
    showClip(view.clip, nodes, mover);
    return;
  }
  const where = view.location;
  heading.textContent = where.name;
  detail.textContent = roomText(where);
  body.replaceChildren(...pathBlock(pathTo(nodes, where.id), 'Where this is:'));
  if (view.kind === 'container') {
    // From a tag, the held clip counts only when the API found it and ranked with it.
    const holding = subject === TAG ? (view.held_clip_used ? held : null) : held;
    showContainer(view, holding, subject !== TAG, mover);
    return;
  }
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
  await listClips(where.id, mover, mine);
}

let currentNodes = [];

function showClip(clip, nodes, mover) {
  const held = { id: clip.id, label: clipLabel(clip) };
  heading.textContent = `Clip: ${held.label}`;
  detail.textContent = `State: ${stateLabel(clip.state)}.`;
  const path = pathTo(nodes, clip.location_id);
  body.replaceChildren(
    el('h3', 'Where it belongs'),
    el('p', clipPlaceText(path), { id: 'clip-place' }),
    ...pathBlock(path, 'Where that is:'),
  );
  pickUp.hidden = false;
  pickUp.onclick = () => {
    holdClip(held.id, held.label);
    status.textContent = 'Held for ten minutes. Tap a place tag, or choose a place below.';
    mover.show(held, clip.location_id ?? undefined);
  };
}

function showContainer(view, held, browsed, mover) {
  const copy = suggestionCopy(view, held, browsed);
  const choose = (placeId) => {
    const still = heldClip();
    if (!still) {
      status.textContent = 'The held clip timed out. Tap the clip again.';
      return;
    }
    status.textContent = '';
    mover.show(still, placeId);
  };
  const top = el('div', '', { id: 'suggestion', class: 'suggestion' });
  top.append(el('h3', copy.heading), el('p', copy.text, { id: 'suggestion-text' }));
  if (copy.targetId !== null && held) {
    const target = copy.targetId;
    const go = el('button', 'Choose this place', { type: 'button', id: 'suggestion-go' });
    go.addEventListener('click', () => {
      choose(target);
    });
    top.append(go);
  }
  const list = el('ul', '', { id: 'inside-list', class: 'plain' });
  for (const row of insideRows(view.inside, copy.targetId)) {
    const li = el('li');
    if (row.suggested) li.className = 'suggested';
    const text = el('span', row.text);
    li.append(text);
    if (row.suggested) li.append(el('span', 'Suggested', { class: 'badge' }));
    if (!takesClips(row.place)) {
      li.append(el('span', 'Printer slot', { class: 'badge' }));
    } else if (held) {
      const button = el('button', 'Choose', {
        type: 'button',
        'aria-label': `Choose ${row.place.name}`,
      });
      button.addEventListener('click', () => {
        choose(row.place.id);
      });
      li.append(button);
    }
    list.append(li);
  }
  if (view.inside.length === 0) list.append(el('li', 'There are no places inside.'));
  body.append(top, el('h3', 'Places inside'), list);
}

async function listClips(locationId, mover, mine) {
  try {
    const clips = await loadClipsAt(locationId);
    if (mine !== sequence) return;
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
    if (mine !== sequence) return;
    status.textContent =
      error instanceof ApiError ? refusalMessage(error) : 'Could not load the clips here.';
  }
}

/** The non-NFC way to the same views: every place in tree order, chosen with a tap. */
function fillBrowse(nodes) {
  const chosen = subject === TAG ? '' : subject.place;
  const first = el('option', 'Choose a place', { value: '' });
  browsePlace.replaceChildren(first);
  for (const p of pickerNodes(nodes)) {
    const option = el('option', '  '.repeat(p.depth) + p.label, { value: p.id });
    browsePlace.append(option);
  }
  browsePlace.value = chosen;
  browse.hidden = false;
}

browsePlace.addEventListener('change', () => {
  const id = browsePlace.value;
  // Focus stays on the list; the status line says what is shown.
  void show(id === '' ? TAG : { place: id }).then(() => {
    if (!card.hidden && id !== '') status.textContent = `Showing ${heading.textContent}.`;
  });
});

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
