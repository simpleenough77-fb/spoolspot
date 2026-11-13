// SPDX-License-Identifier: AGPL-3.0-or-later
// SPOOL-211, Find a spool on the main page: the list wording (app/public/findspool.js) and that the clip
// view it shows says exactly what the clip tag page says, from the same shared functions, for a clip
// read from the real API. The rendered pages are compared in the browser by scripts/a11y-check.ts.
import { describe, expect, it } from 'vitest';
import { createDevTokenProvider } from '../auth/dev-token.ts';
import { createScopedData } from '../data/scoped.ts';
import { importSeed } from '../seed/import.ts';
import {
  memoryDatabase,
  readJson,
  readSeed,
  SEED_SCHEMA_PATH,
  TENANT_A,
  TEST_TOKEN,
  uuid,
} from '../testing.ts';
import { createApp } from './app.ts';

type Parts = (string | { name: string })[];
interface PathStep {
  id: string;
  name: string;
}
interface Clip {
  id: string;
  state: 'on_spool' | 'spool_empty' | 'free';
  location_id: string | null;
  filament: { manufacturer: string; type: string; color: string };
}
interface TapView {
  partsText(parts: Parts): string;
  pathTo(nodes: unknown[], id: string | null): PathStep[];
  clipPlaceText(path: PathStep[]): Parts;
  clipCardText(
    label: string,
    state: string,
    path: PathStep[],
  ): { heading: Parts; detail: string; belongsHeading: string; place: Parts; pathLead: string };
}
interface MoverModule {
  clipLabel(clip: Clip): string;
  stateLabel(state: string): string;
}
interface FindModule {
  LIST_BOUND: number;
  clipItemParts(clip: Clip, index: number, placeLabel?: string): Parts;
  listedParts(count: number, label: string): Parts;
}

// Plain browser modules with no DOM use at load time, imported as they are served.
const tapView = (await import(new URL('../../public/tapview.js', import.meta.url).href)) as TapView;
const mover = (await import(new URL('../../public/mover.js', import.meta.url).href)) as MoverModule;
const find = (await import(
  new URL('../../public/findspool.js', import.meta.url).href
)) as FindModule;
const T = (parts: Parts): string => tapView.partsText(parts);

async function setup() {
  const { sql, db } = memoryDatabase();
  await importSeed(sql, TENANT_A, readSeed(), readJson(SEED_SCHEMA_PATH));
  const filament = uuid();
  db.prepare(
    "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, 'Acme', 'PLA', 'Red', 'disposable')",
  ).run(TENANT_A, filament);
  const placed = uuid();
  const nowhere = uuid();
  db.prepare(
    "INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, ?, 'FPAGE0000001', ?, 'loc1.shelf-1', 'on_spool'), (?, ?, 'FPAGE0000002', ?, NULL, 'free')",
  ).run(TENANT_A, placed, filament, TENANT_A, nowhere, filament);
  const app = createApp({
    auth: createDevTokenProvider({ token: TEST_TOKEN, tenantId: TENANT_A }),
    data: (p) => createScopedData(sql, p),
    allowedHosts: ['localhost'],
  });
  const get = async (path: string): Promise<unknown> =>
    (
      await app.request(`http://localhost${path}`, {
        headers: { host: 'localhost', authorization: `Bearer ${TEST_TOKEN}` },
      })
    ).json();
  return { get, filament, placed, nowhere };
}

describe('Find a spool: the clip view is the clip tag page’s (SPOOL-211)', () => {
  it('says what the tag page says for the same clip, with or without a place', async () => {
    const { get, filament, placed, nowhere } = await setup();
    const { clips } = (await get(`/api/v1/filaments/${filament}/clips`)) as { clips: Clip[] };
    const { locations } = (await get('/api/v1/locations/tree')) as { locations: unknown[] };
    for (const id of [placed, nowhere]) {
      // The tag page's own answer for the same clip.
      const tag = (await get(
        `/api/v1/tags/${id === placed ? 'FPAGE0000001' : 'FPAGE0000002'}`,
      )) as {
        clip: Clip;
      };
      const listed = clips.find((c) => c.id === id);
      expect(listed).toEqual(tag.clip);
      if (!listed) continue;
      const path = tapView.pathTo(locations, listed.location_id);
      const card = tapView.clipCardText(
        mover.clipLabel(listed),
        mover.stateLabel(listed.state),
        path,
      );
      // What tap.js showClip renders, piece by piece, from the same functions.
      expect(card.heading).toEqual(['Clip: ', { name: mover.clipLabel(tag.clip) }]);
      expect(card.detail).toBe(`State: ${mover.stateLabel(tag.clip.state)}.`);
      expect(card.belongsHeading).toBe('Where it belongs');
      expect(card.place).toEqual(
        tapView.clipPlaceText(tapView.pathTo(locations, tag.clip.location_id)),
      );
      expect(card.pathLead).toBe('Where that is:');
    }
    const placedCard = tapView.clipCardText(
      'Acme PLA Red',
      'on a spool',
      tapView.pathTo(locations, 'loc1.shelf-1'),
    );
    expect(T(placedCard.heading)).toBe('Clip: Acme PLA Red');
    expect(T(placedCard.place)).toBe('This clip belongs at Location 1 - Shelf 1.');
    expect(T(tapView.clipCardText('Acme PLA Red', 'free (no spool)', []).place)).toBe(
      'No place is recorded for this clip.',
    );
  });
});

describe('Find a spool: the list (findspool.js)', () => {
  const clip = (over: Partial<Clip> = {}): Clip => ({
    id: uuid(),
    state: 'on_spool',
    location_id: 'loc1.shelf-1',
    filament: { manufacturer: 'Acme', type: 'PLA', color: 'Red' },
    ...over,
  });

  it('tells clips apart by number, state and place, and says when there is no place', () => {
    expect(T(find.clipItemParts(clip(), 0, 'Active storage › Location 1 - Shelf 1'))).toBe(
      'Clip 1: on a spool, at Active storage › Location 1 - Shelf 1',
    );
    expect(T(find.clipItemParts(clip({ location_id: null, state: 'free' }), 1))).toBe(
      'Clip 2: free (no spool), no place recorded',
    );
    // A place missing from the page's tree: words, never the raw id.
    const missing = find.clipItemParts(clip({ location_id: 'loc2.shelf-9' }), 4);
    expect(T(missing)).toBe('Clip 5: on a spool, at a place not in this page’s list of places');
    expect(T(missing)).not.toContain('loc2.shelf-9');
    // Two clips with the same state at the same place still read differently.
    expect(T(find.clipItemParts(clip(), 2, 'Shelf'))).not.toBe(
      T(find.clipItemParts(clip(), 3, 'Shelf')),
    );
  });

  it('keeps a place name a separate piece, so the page can isolate it in <bdi>', () => {
    expect(find.clipItemParts(clip(), 0, 'a‮b')).toEqual([
      'Clip 1: on a spool, at ',
      { name: 'a‮b' },
    ]);
  });

  it('says how many clips were found, none plainly, and that the list may stop at the bound', () => {
    expect(T(find.listedParts(0, 'Acme PLA Red'))).toBe('No clips of Acme PLA Red are recorded.');
    expect(T(find.listedParts(1, 'Acme PLA Red'))).toBe('1 clip of Acme PLA Red.');
    expect(T(find.listedParts(3, 'Acme PLA Red'))).toBe('3 clips of Acme PLA Red.');
    expect(find.LIST_BOUND).toBe(200);
    expect(T(find.listedParts(200, 'Acme PLA Red'))).toBe(
      '200 clips of Acme PLA Red. Showing the first 200; there may be more.',
    );
  });
});
