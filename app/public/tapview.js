// SPDX-License-Identifier: AGPL-3.0-or-later
// What the tap page says, as plain functions with no DOM and no requests (SPOOL-191), so the wording,
// the chain of places and the order can be unit tested. Everything here is derived from what the API
// already returns: a tag view and the location tree. Nothing is typed by the person.
//
// Sentences are returned as "parts": an array of plain strings and { name } pieces. A name (a place, a
// clip or a filament) is never joined into the sentence as text: the page puts each one in its own
// <bdi>, so bidi control characters in a name cannot reorder the words around it. Nothing is stripped.

const MODE = { hard: 'hard limit', soft: 'soft limit' };
const REASON = {
  same_filament: 'the same filament is already there',
  manufacturer_preference: 'this place is set aside for that manufacturer',
  most_free: 'it has the most room',
};
// First strong isolate and pop directional isolate: the text-only form of <bdi>, for visible text where
// an element cannot go (an <option>). Not used in accessible names: those are spoken, bidi order does
// not matter there, and the extra characters would break matching a control by its name.
const FSI = '\u2068';
const PDI = '\u2069';

const plural = (n, w) => `${String(n)} ${w}${n === 1 ? '' : 's'}`;
/** A name inside a sentence. */
export const name = (value) => ({ name: String(value) });

/** The parts as one string, names as they are (for tests and comparisons). */
export function partsText(parts) {
  return parts.map((p) => (typeof p === 'string' ? p : p.name)).join('');
}

/** The parts as one string, each name wrapped in bidi isolates (for <option> text only). */
export function isolatedText(parts) {
  return parts.map((p) => (typeof p === 'string' ? p : `${FSI}${p.name}${PDI}`)).join('');
}

function validLocation(l) {
  return (
    l !== null &&
    typeof l === 'object' &&
    typeof l.id === 'string' &&
    typeof l.name === 'string' &&
    typeof l.type === 'string' &&
    typeof l.leaf === 'boolean' &&
    Number.isInteger(l.used) &&
    (l.free === null || Number.isInteger(l.free)) &&
    (l.capacity === null || Number.isInteger(l.capacity)) &&
    (l.capacity_mode === null || l.capacity_mode in MODE)
  );
}

function validSuggestion(s) {
  return (
    s === null ||
    (typeof s === 'object' &&
      typeof s.location_id === 'string' &&
      typeof s.name === 'string' &&
      Number.isInteger(s.free) &&
      s.capacity_mode in MODE &&
      typeof s.reason === 'string')
  );
}

/** Whether a tag answer has the shape this page understands. A clip may have no place (null). */
export function validView(v) {
  if (v === null || typeof v !== 'object') return false;
  if (v.kind === 'clip') {
    const c = v.clip;
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
  if (v.kind === 'location') return validLocation(v.location);
  if (v.kind === 'container') {
    return (
      validLocation(v.location) &&
      Array.isArray(v.inside) &&
      v.inside.every(validLocation) &&
      validSuggestion(v.suggestion) &&
      typeof v.held_clip_used === 'boolean'
    );
  }
  return false;
}

/**
 * The request for a container chosen from the place list (SPOOL-210): the same suggestion its tag would
 * give, from GET /api/v1/placement-suggestions. The held clip, if any, is sent as on the tag route.
 */
export function suggestionsPath(placeId, held) {
  const clip = held ? `&held=${encodeURIComponent(held.id)}` : '';
  return `/api/v1/placement-suggestions?count=1&within=${encodeURIComponent(placeId)}${clip}`;
}

/**
 * A container chosen from the list, as the container view its tag gives: the places inside from the
 * tree node, the suggestion from the answer to suggestionsPath. With a clip held the answer carries at
 * most one suggestion and `held_clip_used`, exactly as the tag view. With none it is the plain most-free
 * list, and the first place that is not a slot is the tag view's suggestion (a container tag never
 * suggests a slot with nothing held). Null when the answer has another shape.
 */
export function browsedView(node, answer, held) {
  if (answer === null || typeof answer !== 'object' || !Array.isArray(answer.suggestions)) {
    return null;
  }
  const list = answer.suggestions;
  if (!list.every((s) => s !== null && validSuggestion(s) && typeof s.type === 'string')) {
    return null;
  }
  if (held && (typeof answer.held_clip_used !== 'boolean' || list.length > 1)) return null;
  return {
    kind: 'container',
    location: node,
    inside: leavesUnder(node),
    suggestion: held ? (list[0] ?? null) : (list.find((s) => s.type !== 'active_use') ?? null),
    held_clip_used: held ? answer.held_clip_used : false,
  };
}

/** The places from the top of the tree down to `id`, inclusive, as [{ id, name }], or [] if not found. */
export function pathTo(nodes, id, depth = 0) {
  if (typeof id !== 'string' || depth > 40) return [];
  for (const node of nodes) {
    if (node.id === id) return [{ id: node.id, name: node.name }];
    const below = pathTo(node.children ?? [], id, depth + 1);
    if (below.length > 0) return [{ id: node.id, name: node.name }, ...below];
  }
  return [];
}

/** One node of the tree by id, or null. */
export function findNode(nodes, id, depth = 0) {
  if (typeof id !== 'string' || depth > 40) return null;
  for (const node of nodes) {
    if (node.id === id) return node;
    const below = findNode(node.children ?? [], id, depth + 1);
    if (below) return below;
  }
  return null;
}

/** Every leaf below a tree node, in tree order (what a container tag's `inside` lists). */
export function leavesUnder(node, depth = 0) {
  if (depth > 40) return [];
  if (node.leaf) return [node];
  return (node.children ?? []).flatMap((child) => leavesUnder(child, depth + 1));
}

/** A place and the containers above it, in words: "Shelf 2 (Home, Closet)". */
export function placeSentence(path) {
  const last = path.at(-1);
  if (!last) return [];
  const above = path.slice(0, -1);
  if (above.length === 0) return [name(last.name)];
  const chain = above.flatMap((p, i) => (i === 0 ? [name(p.name)] : [', ', name(p.name)]));
  return [name(last.name), ' (', ...chain, ')'];
}

/** The clip scenario: where the record says the clip belongs. */
export function clipPlaceText(path) {
  const last = path.at(-1);
  return last
    ? ['This clip belongs at ', name(last.name), '.']
    : ['No place is recorded for this clip.'];
}

/**
 * Room at a place, with the same clauses as the main page's tree (tree.js describe): over by N, and for
 * a container the places inside without a capacity set. Takes a tree node; a tag view without `over`
 * or `capacity_unset` counts them as 0. "6 free of 16 (10 used), hard limit."
 */
export function roomText(place) {
  const over = Number.isInteger(place.over) ? place.over : 0;
  const unset = Number.isInteger(place.capacity_unset) ? place.capacity_unset : 0;
  const used = `${String(place.used)} used`;
  if (place.capacity === null) {
    return place.leaf
      ? `Capacity not set (${used}).`
      : `${plural(unset, 'place')} without capacity set (${used}).`;
  }
  let text = `${String(place.free ?? 0)} free of ${String(place.capacity)} (${used})`;
  if (over > 0) text += `, over by ${String(over)}`;
  // Used counts every leaf below; free and capacity count only leaves with a capacity set.
  if (!place.leaf && unset > 0) text += `, ${plural(unset, 'place')} without capacity set`;
  if (place.leaf && place.capacity_mode) text += `, ${MODE[place.capacity_mode]}`;
  return `${text}.`;
}

/** A clip can be moved to any leaf but a slot (slots are loaded by the load workflow). */
export const takesClips = (place) => place.leaf && place.type !== 'active_use';

/** What the status line says after a move: the new place and its chain, from the refreshed tree. */
export function movedText(label, path) {
  const where = placeSentence(path);
  return where.length === 0
    ? ['Moved. ', name(label), ' has no place now.']
    : ['Moved. ', name(label), ' is now at ', ...where, '.'];
}

/**
 * Whether the clip held now is the one a view was drawn for: 'same', 'changed' (another clip was
 * picked up since, for example in another tab) or 'gone' (the hold timed out or was dropped).
 */
export function heldState(drawnFor, now) {
  if (!now) return 'gone';
  return drawnFor !== null && now.id === drawnFor ? 'same' : 'changed';
}

/**
 * Whether the held clip was picked up from a printer slot, from the place the page recorded when it was
 * picked up and that place's type in the tree. Moves out of a slot are refused (the load workflow does
 * that), and nothing else in this app can take it out within the ten-minute hold.
 */
export function heldInSlot(held, nodes) {
  if (!held || typeof held.from !== 'string') return false;
  return findNode(nodes, held.from)?.type === 'active_use';
}

/**
 * The top of a container page, reached by its tag or chosen from the list (both ask the API for the
 * suggestion). `held` is the clip held on this device ({ id, label, from }) or null.
 * The suggestion is for that clip only when the API says it used it (`view.held_clip_used`); otherwise
 * it is the API's plain most-room suggestion and is never presented as being for the held clip.
 * `inSlot`: the place the held clip was picked up from (kept in this browser's storage) is a printer
 * slot. That is trusted only when the server agrees: it used the held clip and returned no suggestion, which is
 * what it does for a clip in a slot. A stale or altered stored place never hides the server's answer. Returns { heading, text, targetId, canChoose }; heading and
 * text are parts; targetId is the API's suggested leaf, never re-ranked here.
 */
export function suggestionCopy(view, held, { inSlot = false } = {}) {
  const used = held !== null && view.held_clip_used === true;
  const missing = held !== null && !used;
  if (used && inSlot && view.suggestion === null) {
    return {
      heading: ['Best place for ', name(held.label)],
      text: [
        name(held.label),
        ' is loaded in a printer slot. Unload it from the printer first; until then it cannot be moved here.',
      ],
      targetId: null,
      canChoose: false,
    };
  }
  const notFound = missing
    ? [
        ' The clip you are holding, ',
        name(held.label),
        ', was not found here. Tap its tag again to hold it.',
      ]
    : [];
  const s = view.suggestion;
  if (s === null) {
    return used
      ? {
          heading: ['Best place for ', name(held.label)],
          text: [
            'No place inside suits ',
            name(held.label),
            ' and has room. You can still choose a place below; a full place with a hard limit asks before anything moves.',
          ],
          targetId: null,
          canChoose: true,
        }
      : {
          heading: ['Most room'],
          text: ['No place inside has a capacity set and room.', ...notFound],
          targetId: null,
          canChoose: false,
        };
  }
  const room = `${plural(s.free, 'place')} free, ${MODE[s.capacity_mode]}`;
  const why = REASON[s.reason] ?? REASON.most_free;
  if (used) {
    return {
      heading: ['Best place for ', name(held.label)],
      text: [
        'Suggested: ',
        name(s.name),
        ` (${room}), because ${why}. It is only a suggestion; you can choose another place below.`,
      ],
      targetId: s.location_id,
      canChoose: true,
    };
  }
  return {
    heading: ['Most room'],
    text: [
      'Suggested: ',
      name(s.name),
      ` (${room}), because ${why}.`,
      ...(missing
        ? notFound
        : [
            ' Hold a clip first (tap its tag, then Move this clip) to get a place chosen for that clip.',
          ]),
    ],
    targetId: s.location_id,
    canChoose: false,
  };
}

/**
 * The places inside a container, in tree order, each marked when it is the suggested one. `nodes` (the
 * tree) gives each place's room with the tree's clauses and, when two places inside share a name, the
 * container above each, so every Choose button has a distinct accessible name.
 */
export function insideRows(inside, targetId, nodes = []) {
  const counts = new Map();
  for (const p of inside) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  return inside.map((given) => {
    const place = findNode(nodes, given.id) ?? given;
    const parent = pathTo(nodes, place.id).at(-2);
    const twin = (counts.get(place.name) ?? 0) > 1 && parent !== undefined;
    return {
      place,
      suggested: targetId !== null && place.id === targetId,
      text: [name(place.name), `: ${roomText(place)}`],
      label: twin
        ? ['Choose ', name(place.name), ' in ', name(parent.name)]
        : ['Choose ', name(place.name)],
    };
  });
}

/** The accessible name of "Choose this place": the visible words, then the place. */
export function suggestedLabel(placeName) {
  return ['Choose this place, ', name(placeName), ' (suggested)'];
}
