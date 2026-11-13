// SPDX-License-Identifier: AGPL-3.0-or-later
// SPOOL-191 part 3, the tap page: the page's own wording and order (app/public/tapview.js), the shared
// mover's hard-limit confirm against the real application, and that the page and the lookup it makes
// still say nothing about unknown, retired and other tenants' tags, signed in or not.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDevTokenProvider } from '../auth/dev-token.ts';
import { createMemorySessionStore } from '../auth/session.ts';
import { createScopedData } from '../data/scoped.ts';
import { importSeed } from '../seed/import.ts';
import {
  memoryDatabase,
  readJson,
  readSeed,
  SEED_SCHEMA_PATH,
  TENANT_A,
  TENANT_B,
  TEST_TOKEN,
  uuid,
} from '../testing.ts';
import { createApp } from './app.ts';

interface PathStep {
  id: string;
  name: string;
}
interface Place {
  id: string;
  name: string;
  type: string;
  leaf: boolean;
  capacity_mode: 'hard' | 'soft' | null;
  capacity: number | null;
  used: number;
  free: number | null;
  over?: number;
  capacity_unset?: number;
  children?: Place[];
}
interface Suggestion {
  location_id: string;
  name: string;
  free: number;
  capacity_mode: 'hard' | 'soft';
  reason: string;
}
interface ContainerView {
  kind: 'container';
  location: Place;
  inside: Place[];
  suggestion: Suggestion | null;
  held_clip_used: boolean;
}
type Parts = (string | { name: string })[];
interface Held {
  id: string;
  label: string;
  from?: string | null;
}
interface Copy {
  heading: Parts;
  text: Parts;
  targetId: string | null;
  canChoose: boolean;
}
interface TapView {
  validView(v: unknown): boolean;
  pathTo(nodes: Place[], id: string | null): PathStep[];
  findNode(nodes: Place[], id: string): Place | null;
  leavesUnder(node: Place): Place[];
  partsText(parts: Parts): string;
  isolatedText(parts: Parts): string;
  placeSentence(path: PathStep[]): Parts;
  clipPlaceText(path: PathStep[]): Parts;
  roomText(place: Place): string;
  takesClips(place: Place): boolean;
  movedText(label: string, path: PathStep[]): Parts;
  heldState(drawnFor: string | null, now: Held | null): 'same' | 'changed' | 'gone';
  heldInSlot(held: Held | null, nodes: Place[]): boolean;
  suggestionCopy(
    view: { suggestion: Suggestion | null; held_clip_used?: boolean },
    held: Held | null,
    options?: { inSlot?: boolean },
  ): Copy;
  suggestionsPath(placeId: string, held: Held | null): string;
  browsedView(node: Place, answer: unknown, held: Held | null): ContainerView | null;
  insideRows(
    inside: Place[],
    targetId: string | null,
    nodes?: Place[],
  ): { place: Place; suggested: boolean; text: Parts; label: Parts }[];
  suggestedLabel(placeName: string): Parts;
}
interface Text {
  textContent: string;
}
interface MoverModule {
  holdClip(id: string, label: string, from?: string | null): void;
  heldClip(): { id: string; label: string; from: string | null } | null;
  requestMove(
    clipId: string,
    to: string,
    confirm: boolean,
    ui: { status: Text; warning: Text; confirmButton: { hidden: boolean; focus(): void } },
  ): Promise<{ moved: boolean } | null>;
}

// The page's modules are plain browser JavaScript with no build step; they import nothing from the DOM
// at load time, so they run here as they are served.
const tapView = (await import(new URL('../../public/tapview.js', import.meta.url).href)) as TapView;
const mover = (await import(new URL('../../public/mover.js', import.meta.url).href)) as MoverModule;

const CODE = 'TEST22';
const SHELL = readFileSync('app/public/tap.html', 'utf8');
const bearer = { authorization: `Bearer ${TEST_TOKEN}` };
const json = { 'content-type': 'application/json' };
const CLIP_TAG = 'TAPPAGE0C11P';
const NOWHERE_TAG = 'TAPPAGE0N0WH';
const ACTIVE_TAG = 'TAPPAGE0ACT1';
const OLD = 'TAPPAGE0RET1';
const NEW = 'TAPPAGE0RET2';
const B_ONLY = 'TAPPAGE0B0NE';
const UNKNOWN = 'TAPPAGE0ZZZZ';
const limits = { resolverPerMinute: 10_000, failedAuthPerMinute: 10_000 };

async function setup() {
  const { sql, db } = memoryDatabase();
  await importSeed(sql, TENANT_A, readSeed(), readJson(SEED_SCHEMA_PATH));
  db.prepare('INSERT INTO tenant_settings (tenant_id) VALUES (?)').run(TENANT_B);
  await importSeed(sql, TENANT_B, readSeed(), readJson(SEED_SCHEMA_PATH));
  const filament = uuid();
  db.prepare(
    "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, 'Acme', 'PLA', 'Red', 'disposable')",
  ).run(TENANT_A, filament);
  let n = 0;
  const clip = (location: string | null, tag?: string): string => {
    n += 1;
    const id = uuid();
    db.prepare(
      "INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, ?, ?, ?, ?, 'on_spool')",
    ).run(TENANT_A, id, tag ?? `TAPPAGEK${String(n).padStart(4, '0')}`, filament, location);
    return id;
  };
  const clipId = clip('loc1.shelf-1', CLIP_TAG);
  const nowhere = clip(null, NOWHERE_TAG);
  db.prepare(
    "INSERT INTO tag (tenant_id, tag_id, kind, target_id) VALUES (?, ?, 'location', 'active')",
  ).run(TENANT_A, ACTIVE_TAG);
  const sessions = createMemorySessionStore();
  const app = createApp({
    auth: createDevTokenProvider({ token: TEST_TOKEN, tenantId: TENANT_A }),
    data: (p) => createScopedData(sql, p),
    allowedHosts: ['localhost'],
    sessions,
    tagPages: { instanceCode: CODE, shell: SHELL },
    rateLimits: limits,
  });
  const appB = createApp({
    auth: createDevTokenProvider({ token: TEST_TOKEN, tenantId: TENANT_B }),
    data: (p) => createScopedData(sql, p),
    allowedHosts: ['localhost'],
    rateLimits: limits,
  });
  const request = (
    path: string,
    init: RequestInit & { app?: ReturnType<typeof createApp> } = {},
  ) => {
    const { app: target, ...rest } = init;
    return (target ?? app).request(`http://localhost${path}`, {
      ...rest,
      headers: { host: 'localhost', ...(rest.headers as Record<string, string> | undefined) },
    });
  };
  const getJson = async (path: string): Promise<unknown> =>
    (await request(path, { headers: bearer })).json();
  return { db, app, appB, request, getJson, clipId, nowhere, clip };
}

/** Status, every header and the body, as one comparable string. */
async function full(res: Response): Promise<string> {
  return `${String(res.status)} ${JSON.stringify([...res.headers])} ${await res.text()}`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const T = (parts: Parts): string => tapView.partsText(parts);

describe('tap page wording (tapview.js)', () => {
  const leaf = (over: Partial<Place> = {}): Place => ({
    id: 'shelf-2',
    name: 'Shelf 2',
    type: 'active_storage',
    leaf: true,
    capacity_mode: 'hard',
    capacity: 10,
    used: 4,
    free: 6,
    over: 0,
    capacity_unset: 0,
    children: [],
    ...over,
  });
  const tree: Place[] = [
    {
      id: 'home',
      name: 'Home',
      type: 'container',
      leaf: false,
      capacity_mode: null,
      capacity: 10,
      used: 4,
      free: 6,
      over: 0,
      capacity_unset: 0,
      children: [
        {
          id: 'closet',
          name: 'Closet',
          type: 'container',
          leaf: false,
          capacity_mode: null,
          capacity: 10,
          used: 4,
          free: 6,
          over: 0,
          capacity_unset: 0,
          children: [
            leaf(),
            leaf({
              id: 'slot-1',
              name: 'Slot 1',
              type: 'active_use',
              capacity: 1,
              used: 1,
              free: 0,
            }),
          ],
        },
        {
          id: 'garage',
          name: 'Garage',
          type: 'container',
          leaf: false,
          capacity_mode: null,
          capacity: 10,
          used: 0,
          free: 10,
          over: 0,
          capacity_unset: 0,
          children: [leaf({ id: 'garage.shelf-2', used: 0, free: 10 })],
        },
      ],
    },
  ];

  it('tells where a clip belongs, with the chain of containers above it (the owner’s scenario)', () => {
    const path = tapView.pathTo(tree, 'shelf-2');
    expect(path.map((p) => p.name)).toEqual(['Home', 'Closet', 'Shelf 2']);
    expect(T(tapView.clipPlaceText(path))).toBe('This clip belongs at Shelf 2.');
    expect(T(tapView.placeSentence(path))).toBe('Shelf 2 (Home, Closet)');
    expect(T(tapView.movedText('Acme PLA Red', path))).toBe(
      'Moved. Acme PLA Red is now at Shelf 2 (Home, Closet).',
    );
  });

  it('keeps every name a separate piece, and isolates it when it must be plain text', () => {
    const path = tapView.pathTo(tree, 'shelf-2');
    expect(tapView.movedText('Acme PLA Red', path)).toEqual([
      'Moved. ',
      { name: 'Acme PLA Red' },
      ' is now at ',
      { name: 'Shelf 2' },
      ' (',
      { name: 'Home' },
      ', ',
      { name: 'Closet' },
      ')',
      '.',
    ]);
    // A right-to-left override in a name is kept, but cannot leak past the name.
    expect(tapView.isolatedText(['Choose ', { name: 'a‮b' }])).toBe('Choose ⁨a‮b⁩');
  });

  it('says plainly when a clip has no place', () => {
    expect(tapView.pathTo(tree, null)).toEqual([]);
    expect(tapView.pathTo(tree, 'gone')).toEqual([]);
    expect(T(tapView.clipPlaceText([]))).toBe('No place is recorded for this clip.');
  });

  describe('room, with the main page’s clauses (L4)', () => {
    it('zero used, and the limit in words', () => {
      expect(tapView.roomText(leaf({ used: 0, free: 10 }))).toBe(
        '10 free of 10 (0 used), hard limit.',
      );
    });
    it('exactly full at a hard limit', () => {
      expect(tapView.roomText(leaf({ used: 10, free: 0 }))).toBe(
        '0 free of 10 (10 used), hard limit.',
      );
    });
    it('over-full at a soft limit says by how much', () => {
      expect(
        tapView.roomText(leaf({ capacity_mode: 'soft', capacity: 4, used: 6, free: 0, over: 2 })),
      ).toBe('0 free of 4 (6 used), over by 2, soft limit.');
    });
    it('a leaf with no capacity set', () => {
      expect(tapView.roomText(leaf({ capacity: null, free: null, used: 1 }))).toBe(
        'Capacity not set (1 used).',
      );
    });
    it('a container counts places without a capacity set, singular and plural', () => {
      const box = { ...leaf(), leaf: false, type: 'container', capacity_mode: null };
      expect(
        tapView.roomText({ ...box, capacity: 137, used: 7, free: 135, capacity_unset: 1 }),
      ).toBe('135 free of 137 (7 used), 1 place without capacity set.');
      expect(
        tapView.roomText({ ...box, capacity: 137, used: 7, free: 135, capacity_unset: 14 }),
      ).toBe('135 free of 137 (7 used), 14 places without capacity set.');
      expect(
        tapView.roomText({ ...box, capacity: null, free: null, used: 3, capacity_unset: 1 }),
      ).toBe('1 place without capacity set (3 used).');
      expect(
        tapView.roomText({ ...box, capacity: null, free: null, used: 3, capacity_unset: 2 }),
      ).toBe('2 places without capacity set (3 used).');
    });
  });

  it('accepts a clip with no place and a container answer, and refuses anything else', () => {
    const clip = {
      kind: 'clip',
      clip: {
        id: 'x',
        state: 'free',
        location_id: null,
        filament: { manufacturer: 'A', type: 'PLA', color: 'Red' },
      },
    };
    expect(tapView.validView(clip)).toBe(true);
    expect(tapView.validView({ ...clip, clip: { ...clip.clip, location_id: 3 } })).toBe(false);
    expect(tapView.validView({ kind: 'container', location: tree[0] })).toBe(false);
    expect(tapView.validView(null)).toBe(false);
    expect(tapView.validView({ kind: 'other' })).toBe(false);
  });

  it('never offers a printer slot for a clip move', () => {
    const shelf = tapView.findNode(tree, 'shelf-2');
    const slot = tapView.findNode(tree, 'slot-1');
    if (!shelf || !slot) throw new Error('missing');
    expect(tapView.takesClips(shelf)).toBe(true);
    expect(tapView.takesClips(slot)).toBe(false);
    expect(tapView.takesClips({ ...shelf, leaf: false })).toBe(false);
  });

  it('knows whether the held clip is still the one a view was drawn for (L1)', () => {
    const a = { id: 'a', label: 'A' };
    expect(tapView.heldState('a', a)).toBe('same');
    expect(tapView.heldState('a', { id: 'b', label: 'B' })).toBe('changed');
    expect(tapView.heldState('a', null)).toBe('gone');
    expect(tapView.heldState(null, a)).toBe('changed');
  });

  it('knows a held clip picked up from a slot, from the tree only (L3)', () => {
    expect(tapView.heldInSlot({ id: 'a', label: 'A', from: 'slot-1' }, tree)).toBe(true);
    expect(tapView.heldInSlot({ id: 'a', label: 'A', from: 'shelf-2' }, tree)).toBe(false);
    expect(tapView.heldInSlot({ id: 'a', label: 'A', from: null }, tree)).toBe(false);
    expect(tapView.heldInSlot(null, tree)).toBe(false);
  });

  const suggestion: Suggestion = {
    location_id: 'shelf-2',
    name: 'Shelf 2',
    free: 6,
    capacity_mode: 'hard',
    reason: 'most_free',
  };
  const held = { id: 'c', label: 'Acme PLA Red' };

  it('a held clip loaded in a slot: says so, no target and no Choose (L3)', () => {
    const copy = tapView.suggestionCopy({ suggestion: null, held_clip_used: true }, held, {
      inSlot: true,
    });
    expect(T(copy.text)).toBe(
      'Acme PLA Red is loaded in a printer slot. Unload it from the printer first; until then it cannot be moved here.',
    );
    expect(copy.targetId).toBeNull();
    expect(copy.canChoose).toBe(false);
  });

  it('a stored slot place is not trusted when the server returned a suggestion (L6)', () => {
    const copy = tapView.suggestionCopy({ suggestion, held_clip_used: true }, held, {
      inSlot: true,
    });
    expect(T(copy.text)).not.toContain('printer slot');
    expect(T(copy.heading)).toBe('Best place for Acme PLA Red');
    expect(T(copy.text)).toContain('Suggested: Shelf 2 (');
    expect(copy.targetId).toBe('shelf-2');
    expect(copy.canChoose).toBe(true);
    // Nor when the server did not use the held clip at all.
    const unused = tapView.suggestionCopy({ suggestion: null, held_clip_used: false }, held, {
      inSlot: true,
    });
    expect(T(unused.text)).not.toContain('printer slot');
  });

  it('accessible names are plain words with the visible label first (N1, WCAG 2.5.3)', () => {
    const rows = tapView.insideRows([leaf()], null, tree);
    const label = tapView.partsText(rows[0]?.label ?? []);
    expect(label).toBe('Choose Shelf 2');
    expect(label).not.toMatch(/[\u2066-\u2069]/u);
    const go = tapView.partsText(tapView.suggestedLabel('Shelf 2'));
    expect(go.startsWith('Choose this place')).toBe(true);
    expect(go).not.toMatch(/[\u2066-\u2069]/u);
  });

  it('never presents the suggestion as for the held clip when the API did not use it (L2)', () => {
    const copy = tapView.suggestionCopy({ suggestion, held_clip_used: false }, held);
    expect(T(copy.heading)).toBe('Most room');
    expect(T(copy.text)).not.toContain('Best place');
    expect(T(copy.text)).toContain(
      'The clip you are holding, Acme PLA Red, was not found here. Tap its tag again to hold it.',
    );
    expect(T(copy.text)).not.toContain('Hold a clip first');
    expect(copy.canChoose).toBe(false);
    const none = tapView.suggestionCopy({ suggestion: null, held_clip_used: false }, held);
    expect(T(none.heading)).toBe('Most room');
    expect(T(none.text)).toContain('was not found here');
    expect(none.canChoose).toBe(false);
  });

  it('says when nothing inside has room', () => {
    const used = tapView.suggestionCopy({ suggestion: null, held_clip_used: true }, held);
    expect(T(used.heading)).toBe('Best place for Acme PLA Red');
    expect(used).toMatchObject({ targetId: null, canChoose: true });
    expect(T(tapView.suggestionCopy({ suggestion: null, held_clip_used: false }, null).text)).toBe(
      'No place inside has a capacity set and room.',
    );
  });

  it('gives each Choose a distinct name: the parent is added when two places share a name', () => {
    const inside = [leaf(), leaf({ id: 'garage.shelf-2' }), leaf({ id: 'slot-1', name: 'Slot 1' })];
    const rows = tapView.insideRows(inside, 'garage.shelf-2', tree);
    expect(rows.map((r) => T(r.label))).toEqual([
      'Choose Shelf 2 in Closet',
      'Choose Shelf 2 in Garage',
      'Choose Slot 1',
    ]);
    expect(rows.map((r) => r.suggested)).toEqual([false, true, false]);
    // Room comes from the tree node when there is one.
    expect(T(rows[1]?.text ?? [])).toBe('Shelf 2: 10 free of 10 (0 used), hard limit.');
    // The suggested button's accessible name starts with its visible words (label in name).
    expect(T(tapView.suggestedLabel('Shelf 2'))).toBe('Choose this place, Shelf 2 (suggested)');
  });
});

describe('a container chosen from the list (SPOOL-210)', () => {
  const node: Place = {
    id: 'closet',
    name: 'Closet',
    type: 'container',
    leaf: false,
    capacity_mode: null,
    capacity: 10,
    used: 0,
    free: 10,
    children: [
      {
        id: 'slot-1',
        name: 'Slot 1',
        type: 'active_use',
        leaf: true,
        capacity_mode: 'hard',
        capacity: 1,
        used: 0,
        free: 1,
      },
      {
        id: 'shelf-2',
        name: 'Shelf 2',
        type: 'active_storage',
        leaf: true,
        capacity_mode: 'hard',
        capacity: 10,
        used: 4,
        free: 6,
      },
    ],
  };
  const s = (id: string, type: string) => ({
    location_id: id,
    name: id,
    type,
    capacity_mode: 'hard',
    free: 1,
    fits_all: true,
    reason: 'most_free',
  });
  const held = { id: '00000000-0000-4000-8000-0000000000c1', label: 'Acme PLA Red' };
  const leafOf = (n: Place): Place => {
    const leaf = n.children?.[1];
    if (!leaf) throw new Error('no leaf');
    return leaf;
  };

  it('asks for one unit inside the place, with the held clip when there is one', () => {
    expect(tapView.suggestionsPath('loc1.shelf-1', null)).toBe(
      '/api/v1/placement-suggestions?count=1&within=loc1.shelf-1',
    );
    expect(tapView.suggestionsPath('a&b', held)).toBe(
      `/api/v1/placement-suggestions?count=1&within=a%26b&held=${held.id}`,
    );
  });

  it('builds the same view a container tag gives, slots left out with nothing held', () => {
    const plain = tapView.browsedView(
      node,
      { suggestions: [s('slot-1', 'active_use'), s('shelf-2', 'active_storage')] },
      null,
    );
    expect(plain).toMatchObject({ kind: 'container', held_clip_used: false });
    expect(plain?.suggestion?.location_id).toBe('shelf-2');
    expect(tapView.validView(plain)).toBe(true);
    expect(
      tapView.browsedView(node, { suggestions: [s('slot-1', 'active_use')] }, null)?.suggestion,
    ).toBeNull();
    const forHeld = tapView.browsedView(
      node,
      { suggestions: [s('shelf-2', 'active_storage')], held_clip_used: true },
      held,
    );
    expect(forHeld).toMatchObject({ held_clip_used: true, suggestion: { location_id: 'shelf-2' } });
    expect(T(tapView.suggestionCopy(forHeld ?? { suggestion: null }, held).heading)).toBe(
      'Best place for Acme PLA Red',
    );
    // The server's answer, not the stored place alone, decides the slot message (L6 holds here too).
    const inSlot = tapView.browsedView(node, { suggestions: [], held_clip_used: true }, held);
    expect(
      T(tapView.suggestionCopy(inSlot ?? { suggestion: null }, held, { inSlot: true }).text),
    ).toContain('is loaded in a printer slot');
    const notFound = tapView.browsedView(
      node,
      { suggestions: [s('shelf-2', 'active_storage')], held_clip_used: false },
      held,
    );
    const copy = tapView.suggestionCopy(notFound ?? { suggestion: null }, held, { inSlot: true });
    expect(T(copy.text)).toContain('was not found here');
    expect(copy.canChoose).toBe(false);
  });

  it('accepts only its own limit and reason names, never inherited ones such as toString', () => {
    for (const bad of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(
        tapView.browsedView(
          node,
          { suggestions: [{ ...s('shelf-2', 'active_storage'), capacity_mode: bad }] },
          null,
        ),
        bad,
      ).toBeNull();
      expect(
        tapView.validView({
          kind: 'location',
          location: { ...node.children?.[1], capacity_mode: bad },
        }),
        bad,
      ).toBe(false);
      // An unknown reason reads as "most room", not as an inherited function's text.
      const copy = tapView.suggestionCopy(
        { suggestion: { ...s('shelf-2', 'active_storage'), capacity_mode: 'hard', reason: bad } },
        null,
      );
      expect(T(copy.text)).toContain('because it has the most room.');
      expect(tapView.roomText({ ...leafOf(node), capacity_mode: bad as 'hard' })).toBe(
        '6 free of 10 (4 used).',
      );
    }
  });

  it('refuses an answer of another shape', () => {
    for (const answer of [
      null,
      [],
      { suggestions: null },
      { suggestions: [null] },
      { suggestions: [{ ...s('shelf-2', 'active_storage'), free: '1' }] },
      { suggestions: [{ ...s('shelf-2', 'active_storage'), type: 3 }] },
    ]) {
      expect(tapView.browsedView(node, answer, null)).toBeNull();
    }
    // With a clip held: held_clip_used must be there, and at most one suggestion.
    expect(tapView.browsedView(node, { suggestions: [] }, held)).toBeNull();
    expect(
      tapView.browsedView(
        node,
        { suggestions: [s('a', 'active_storage'), s('b', 'active_storage')], held_clip_used: true },
        held,
      ),
    ).toBeNull();
  });
});

describe('the container suggestion on the page is the API’s', () => {
  it('shows the API’s suggestion for the held clip at the top and marks only that place inside', async () => {
    const { getJson, clipId } = await setup();
    const view = (await getJson(`/api/v1/tags/${ACTIVE_TAG}?held=${clipId}`)) as ContainerView;
    expect(tapView.validView(view)).toBe(true);
    expect(view.held_clip_used).toBe(true);
    const suggestion = view.suggestion;
    if (!suggestion) throw new Error('expected a suggestion');
    const copy = tapView.suggestionCopy(view, { id: clipId, label: 'Acme PLA Red' });
    expect(copy.targetId).toBe(suggestion.location_id);
    expect(copy.canChoose).toBe(true);
    expect(T(copy.text)).toContain(`Suggested: ${suggestion.name} (`);
    expect(T(copy.text)).toContain('only a suggestion');
    const rows = tapView.insideRows(view.inside, copy.targetId);
    expect(rows.map((r) => r.place.id)).toEqual(view.inside.map((p) => p.id));
    expect(rows.filter((r) => r.suggested).map((r) => r.place.id)).toEqual([
      suggestion.location_id,
    ]);
  });

  it('keeps the API’s choice when it is not the place with the most room (no re-ranking)', async () => {
    const { getJson, clipId, clip } = await setup();
    // Another clip of the same filament on a 10-place shelf: the API prefers it over 12-place shelves.
    clip('loc2.shelf-1');
    const view = (await getJson(`/api/v1/tags/${ACTIVE_TAG}?held=${clipId}`)) as ContainerView;
    expect(view.suggestion).toMatchObject({ location_id: 'loc2.shelf-1', reason: 'same_filament' });
    const roomiest = Math.max(...view.inside.map((p) => p.free ?? 0));
    expect(view.suggestion?.free).toBeLessThan(roomiest);
    const copy = tapView.suggestionCopy(view, { id: clipId, label: 'Acme PLA Red' });
    expect(copy.targetId).toBe('loc2.shelf-1');
    expect(T(copy.text)).toContain(
      'Suggested: Location 2 - Shelf 1 (9 places free, hard limit), because the same filament is already there.',
    );
    expect(
      tapView
        .insideRows(view.inside, copy.targetId)
        .filter((r) => r.suggested)
        .map((r) => r.place.id),
    ).toEqual(['loc2.shelf-1']);
  });

  it('a held clip the server does not know: not presented as ranked for it, and no Choose (L2)', async () => {
    const { getJson } = await setup();
    const unknownClip = uuid();
    const view = (await getJson(`/api/v1/tags/${ACTIVE_TAG}?held=${unknownClip}`)) as ContainerView;
    expect(view.held_clip_used).toBe(false);
    const copy = tapView.suggestionCopy(view, { id: unknownClip, label: 'Acme PLA Red' });
    expect(T(copy.heading)).toBe('Most room');
    expect(T(copy.text)).toContain('was not found here. Tap its tag again to hold it.');
    expect(copy.canChoose).toBe(false);
  });

  it('with nothing held, shows the API’s most-room suggestion and offers no move', async () => {
    const { getJson } = await setup();
    const view = (await getJson(`/api/v1/tags/${ACTIVE_TAG}`)) as ContainerView;
    const suggestion = view.suggestion;
    if (!suggestion) throw new Error('expected a suggestion');
    const copy = tapView.suggestionCopy(view, null);
    expect(T(copy.heading)).toBe('Most room');
    expect(copy.targetId).toBe(suggestion.location_id);
    expect(copy.canChoose).toBe(false);
  });

  it('builds the clip’s chain from the tree endpoint alone (no new request)', async () => {
    const { getJson } = await setup();
    const clip = (await getJson(`/api/v1/tags/${CLIP_TAG}`)) as {
      clip: { location_id: string | null };
    };
    const tree = (await getJson('/api/v1/locations/tree')) as { locations: Place[] };
    const path = tapView.pathTo(tree.locations, clip.clip.location_id);
    expect(path.map((p) => p.name)).toEqual([
      'Home',
      'Active storage',
      'Location 1',
      'Location 1 - Shelf 1',
    ]);
    const none = (await getJson(`/api/v1/tags/${NOWHERE_TAG}`)) as {
      clip: { location_id: string | null };
    };
    expect(tapView.validView(none)).toBe(true);
    expect(T(tapView.clipPlaceText(tapView.pathTo(tree.locations, none.clip.location_id)))).toBe(
      'No place is recorded for this clip.',
    );
  });
});

describe('the held clip in browser storage (mover.js, N3)', () => {
  const KEY = 'spoolspot.held-clip';
  const ID = '00000000-0000-4000-8000-000000000001';
  function fakeStorage() {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        data.set(k, v);
      },
      removeItem: (k: string) => {
        data.delete(k);
      },
    };
  }
  const stored = (from: unknown, omit = false) => {
    const storage = fakeStorage();
    const raw: Record<string, unknown> = { id: ID, label: 'Acme PLA Red', at: Date.now() };
    if (!omit) raw.from = from;
    storage.setItem(KEY, JSON.stringify(raw));
    vi.stubGlobal('localStorage', storage);
    return storage;
  };

  it('keeps a valid place it was picked up from', () => {
    stored('loc1.shelf-1');
    expect(mover.heldClip()).toEqual({ id: ID, label: 'Acme PLA Red', from: 'loc1.shelf-1' });
  });

  it.each([
    ['a number', 5],
    ['an object', { id: 'loc1' }],
    ['over 64 characters', `a${'.b'.repeat(40)}`],
    ['characters outside the place-id pattern', 'Loc 1/../x'],
    ['markup', '<img src=x>'],
    ['null', null],
  ])('turns a stored place that is %s into null, and keeps the hold', (_what, from) => {
    const storage = stored(from);
    expect(mover.heldClip()).toEqual({ id: ID, label: 'Acme PLA Red', from: null });
    expect(storage.data.has(KEY)).toBe(true);
  });

  it('turns a missing place into null, and keeps the hold', () => {
    const storage = stored(undefined, true);
    expect(mover.heldClip()).toEqual({ id: ID, label: 'Acme PLA Red', from: null });
    expect(storage.data.has(KEY)).toBe(true);
  });

  it('stores only a valid place when holding', () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    mover.holdClip(ID, 'Acme PLA Red', 'Not A Place!');
    expect(JSON.parse(storage.data.get(KEY) ?? '{}')).toMatchObject({ id: ID, from: null });
    mover.holdClip(ID, 'Acme PLA Red', 'clips.bin-1');
    expect(mover.heldClip()?.from).toBe('clips.bin-1');
  });
});

describe('a move from the tap page past a hard limit', () => {
  it('surfaces the existing "Move anyway" confirm, not a silent failure, then moves once confirmed', async () => {
    const { db, request, clipId, clip } = await setup();
    db.prepare('UPDATE location SET capacity = 1 WHERE tenant_id = ? AND id = ?').run(
      TENANT_A,
      'loc1.shelf-2',
    );
    clip('loc1.shelf-2');
    // The page's own fetch, answered by the real application.
    vi.stubGlobal('fetch', (path: string, init: RequestInit = {}) =>
      request(path, {
        method: init.method ?? 'GET',
        headers: { ...(init.headers as Record<string, string>), ...bearer, ...json },
        ...(init.body === undefined ? {} : { body: init.body }),
      }),
    );
    const focus = vi.fn();
    const ui = {
      status: { textContent: '' },
      warning: { textContent: '' },
      confirmButton: { hidden: true, focus },
    };
    expect(await mover.requestMove(clipId, 'loc1.shelf-2', false, ui)).toBeNull();
    expect(ui.warning.textContent).toBe('Warning: this goes 1 over the hard limit.');
    expect(ui.confirmButton.hidden).toBe(false);
    expect(focus).toHaveBeenCalledOnce();
    const where = () =>
      (
        db.prepare('SELECT location_id FROM clip WHERE id = ?').get(clipId) as {
          location_id: string;
        }
      ).location_id;
    expect(where()).toBe('loc1.shelf-1');
    expect(await mover.requestMove(clipId, 'loc1.shelf-2', true, ui)).toMatchObject({
      moved: true,
    });
    expect(ui.status.textContent).toBe('Moved.');
    expect(where()).toBe('loc1.shelf-2');
  });
});

describe('unknown, retired and other tenants’ tags stay indistinguishable', () => {
  async function retireSetup() {
    const s = await setup();
    const claim = (tag: string, body: unknown, app = s.app) =>
      s.request(`/api/v1/tags/${tag}/claim`, {
        method: 'POST',
        headers: { ...bearer, ...json },
        body: JSON.stringify(body),
        app,
      });
    expect((await claim(OLD, { location_id: 'loc2.shelf-1' })).status).toBe(200);
    expect((await claim(NEW, { location_id: 'loc2.shelf-1', replace: true })).status).toBe(200);
    expect((await claim(B_ONLY, { location_id: 'loc2.shelf-1' }, s.appB)).status).toBe(200);
    const retired = s.db
      .prepare('SELECT tag_id FROM tag_retired WHERE tenant_id = ?')
      .all(TENANT_A) as { tag_id: string }[];
    expect(retired.map((r) => r.tag_id)).toEqual([OLD]);
    return s;
  }

  it('serves the real tap page byte-identically for every tag of this instance, signed in or not', async () => {
    const { request } = await retireSetup();
    const session = await request('/api/v1/session', { method: 'POST', headers: bearer });
    const cookie = (session.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(cookie).not.toBe('');
    const pages = new Set<string>();
    for (const tag of [CLIP_TAG, NOWHERE_TAG, ACTIVE_TAG, OLD, NEW, B_ONLY, UNKNOWN]) {
      pages.add(await full(await request(`/${CODE}${tag}`)));
      pages.add(await full(await request(`/${CODE}${tag}`, { headers: { cookie } })));
    }
    expect(pages.size).toBe(1);
    expect([...pages][0]).toContain(SHELL);
  });

  it('answers the lookup the page makes, with or without a held clip, identically for them', async () => {
    const { request, clipId } = await retireSetup();
    const answers = async (tag: string) => [
      await full(await request(`/api/v1/tags/${tag}`, { headers: bearer })),
      await full(await request(`/api/v1/tags/${tag}?held=${clipId}`, { headers: bearer })),
      await full(await request(`/api/v1/tags/${tag}?held=${clipId}`)),
      await full(await request(`/api/v1/tags/${tag}`)),
    ];
    const unknown = await answers(UNKNOWN);
    expect(unknown[0]).toMatch(/^404 /);
    expect(unknown[1]).toBe(unknown[0]);
    expect(unknown[2]).toMatch(/^401 /);
    expect(unknown[3]).toBe(unknown[2]);
    for (const tag of [OLD, B_ONLY]) expect(await answers(tag), tag).toEqual(unknown);
  });
});
