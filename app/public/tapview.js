// SPDX-License-Identifier: AGPL-3.0-or-later
// What the tap page says, as plain functions with no DOM and no requests (SPOOL-191), so the wording,
// the chain of places and the order can be unit tested. Everything here is derived from what the API
// already returns: a tag view and the location tree. Nothing is typed by the person.

const MODE = { hard: 'hard limit', soft: 'soft limit' };
const REASON = {
  same_filament: 'the same filament is already there',
  manufacturer_preference: 'this place is set aside for that manufacturer',
  most_free: 'it has the most room',
};

const plural = (n, w) => `${String(n)} ${w}${n === 1 ? '' : 's'}`;

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
  if (depth > 40) return null;
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
  if (!last) return '';
  const above = path.slice(0, -1).map((p) => p.name);
  return above.length === 0 ? last.name : `${last.name} (${above.join(', ')})`;
}

/** The clip scenario: where the record says the clip belongs. */
export function clipPlaceText(path) {
  const last = path.at(-1);
  return last ? `This clip belongs at ${last.name}.` : 'No place is recorded for this clip.';
}

/** Room at a place: "6 free of 16 (10 used), hard limit." */
export function roomText(place) {
  if (place.capacity === null) return `Capacity not set (${plural(place.used, 'item')} stored).`;
  const mode = place.leaf && place.capacity_mode ? `, ${MODE[place.capacity_mode]}` : '';
  return `${String(place.free ?? 0)} free of ${String(place.capacity)} (${String(place.used)} used)${mode}.`;
}

/** A clip can be moved to any leaf but a slot (slots are loaded by the load workflow). */
export const takesClips = (place) => place.leaf && place.type !== 'active_use';

/** What the status line says after a move: the new place and its chain. */
export function movedText(label, path) {
  const where = placeSentence(path);
  return where === '' ? `Moved. ${label} has no place now.` : `Moved. ${label} is now at ${where}.`;
}

/**
 * The top of a container page. `held` is the held clip ({ id, label }) when the API used it for the
 * ranking, otherwise null. `browsed` is true when the person chose the container from the list instead
 * of tapping its tag (no suggestion is asked for then). Returns { heading, text, targetId }; targetId is
 * the suggested leaf (always the API's suggestion, never re-ranked here) or null.
 */
export function suggestionCopy(view, held, browsed = false) {
  if (browsed) {
    return {
      heading: 'Suggested place',
      text: 'Tap this container’s tag to get a suggested place. You can still choose a place below.',
      targetId: null,
    };
  }
  const s = view.suggestion;
  if (s === null) {
    return {
      heading: held ? `Best place for ${held.label}` : 'Most room',
      text: held
        ? `No place inside suits ${held.label} and has room. You can still choose a place below; a full place with a hard limit asks before anything moves.`
        : 'No place inside has a capacity set and room.',
      targetId: null,
    };
  }
  const room = `${plural(s.free, 'place')} free, ${MODE[s.capacity_mode]}`;
  const why = REASON[s.reason] ?? REASON.most_free;
  return held
    ? {
        heading: `Best place for ${held.label}`,
        text: `Suggested: ${s.name} (${room}), because ${why}. It is only a suggestion; you can choose another place below.`,
        targetId: s.location_id,
      }
    : {
        heading: 'Most room',
        text: `Suggested: ${s.name} (${room}), because ${why}. Hold a clip first (tap its tag, then Move this clip) to get a place chosen for that clip.`,
        targetId: s.location_id,
      };
}

/** The places inside a container, in tree order, each marked when it is the suggested one. */
export function insideRows(inside, targetId) {
  return inside.map((place) => ({
    place,
    suggested: targetId !== null && place.id === targetId,
    text: `${place.name}: ${roomText(place)}`,
  }));
}
