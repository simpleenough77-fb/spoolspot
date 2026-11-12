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
interface Copy {
  heading: string;
  text: string;
  targetId: string | null;
}
interface TapView {
  validView(v: unknown): boolean;
  pathTo(nodes: Place[], id: string | null): PathStep[];
  findNode(nodes: Place[], id: string): Place | null;
  leavesUnder(node: Place): Place[];
  placeSentence(path: PathStep[]): string;
  clipPlaceText(path: PathStep[]): string;
  roomText(place: Place): string;
  takesClips(place: Place): boolean;
  movedText(label: string, path: PathStep[]): string;
  suggestionCopy(
    view: { suggestion: Suggestion | null },
    held: { id: string; label: string } | null,
    browsed?: boolean,
  ): Copy;
  insideRows(
    inside: Place[],
    targetId: string | null,
  ): { place: Place; suggested: boolean; text: string }[];
}
interface Text {
  textContent: string;
}
interface MoverModule {
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

describe('tap page wording (tapview.js)', () => {
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
          children: [
            {
              id: 'shelf-2',
              name: 'Shelf 2',
              type: 'active_storage',
              leaf: true,
              capacity_mode: 'hard',
              capacity: 10,
              used: 4,
              free: 6,
              children: [],
            },
          ],
        },
      ],
    },
  ];

  it('tells where a clip belongs, with the chain of containers above it (the owner’s scenario)', () => {
    const path = tapView.pathTo(tree, 'shelf-2');
    expect(path.map((p) => p.name)).toEqual(['Home', 'Closet', 'Shelf 2']);
    expect(tapView.clipPlaceText(path)).toBe('This clip belongs at Shelf 2.');
    expect(tapView.placeSentence(path)).toBe('Shelf 2 (Home, Closet)');
    expect(tapView.movedText('Acme PLA Red', path)).toBe(
      'Moved. Acme PLA Red is now at Shelf 2 (Home, Closet).',
    );
  });

  it('says plainly when a clip has no place', () => {
    expect(tapView.pathTo(tree, null)).toEqual([]);
    expect(tapView.pathTo(tree, 'gone')).toEqual([]);
    expect(tapView.clipPlaceText([])).toBe('No place is recorded for this clip.');
  });

  it('describes room with the limit in words, and an unset capacity', () => {
    const shelf = tapView.findNode(tree, 'shelf-2');
    if (!shelf) throw new Error('missing');
    expect(tapView.roomText(shelf)).toBe('6 free of 10 (4 used), hard limit.');
    expect(tapView.roomText({ ...shelf, capacity: null, free: null, used: 1 })).toBe(
      'Capacity not set (1 item stored).',
    );
    const home = tree[0];
    if (!home) throw new Error('missing');
    expect(tapView.roomText(home)).toBe('6 free of 10 (4 used).');
    expect(tapView.leavesUnder(home).map((l) => l.id)).toEqual(['shelf-2']);
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
    if (!shelf) throw new Error('missing');
    expect(tapView.takesClips(shelf)).toBe(true);
    expect(tapView.takesClips({ ...shelf, type: 'active_use' })).toBe(false);
    expect(tapView.takesClips({ ...shelf, leaf: false })).toBe(false);
  });

  it('says when nothing inside has room, and when a container was chosen without its tag', () => {
    const held = { id: 'c', label: 'Acme PLA Red' };
    expect(tapView.suggestionCopy({ suggestion: null }, held)).toMatchObject({
      heading: 'Best place for Acme PLA Red',
      targetId: null,
    });
    expect(tapView.suggestionCopy({ suggestion: null }, null).text).toBe(
      'No place inside has a capacity set and room.',
    );
    expect(tapView.suggestionCopy({ suggestion: null }, held, true).targetId).toBeNull();
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
    expect(copy.text).toContain(`Suggested: ${suggestion.name} (`);
    expect(copy.text).toContain('only a suggestion');
    const rows = tapView.insideRows(view.inside, copy.targetId);
    expect(rows.map((r) => r.place.id)).toEqual(view.inside.map((p) => p.id));
    expect(rows.filter((r) => r.suggested).map((r) => r.place.id)).toEqual([
      suggestion.location_id,
    ]);
  });

  it('with nothing held, shows the API’s most-room suggestion and offers no move', async () => {
    const { getJson } = await setup();
    const view = (await getJson(`/api/v1/tags/${ACTIVE_TAG}`)) as ContainerView;
    const suggestion = view.suggestion;
    if (!suggestion) throw new Error('expected a suggestion');
    const copy = tapView.suggestionCopy(view, null);
    expect(copy.heading).toBe('Most room');
    expect(copy.targetId).toBe(suggestion.location_id);
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
    expect(tapView.clipPlaceText(tapView.pathTo(tree.locations, none.clip.location_id))).toBe(
      'No place is recorded for this clip.',
    );
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
