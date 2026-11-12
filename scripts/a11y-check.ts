// SPDX-License-Identifier: AGPL-3.0-or-later
// CI check: automated WCAG 2.2 A/AA scan (axe-core) of every HTML page under app/public.
// Automated checks find only part of the issues; the manual checklist still applies to changed UI.
//
// Browser: set CHROME_PATH to a Chrome/Chromium binary, or leave it unset to use the installed
// Google Chrome ("chrome" channel), which GitHub's ubuntu runners include.
/// <reference lib="dom" />
// The page-side callbacks below run in the browser, so this file needs the DOM types.
import { AxeBuilder } from '@axe-core/playwright';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { chromium, type Page } from 'playwright-core';
import { createDevTokenProvider } from '../app/src/auth/dev-token.ts';
import { createScopedData } from '../app/src/data/scoped.ts';
import { runMigrations } from '../app/src/db/migrate.ts';
import { openDatabase, sqlFromDatabase } from '../app/src/db/sqlite.ts';
import { createMemorySessionStore } from '../app/src/auth/session.ts';
import { createApp } from '../app/src/http/app.ts';
import { importSeed } from '../app/src/seed/import.ts';
import type { SeedDocument } from '../app/src/seed/validate.ts';

const root = 'app/public';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

function htmlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return htmlFiles(full);
    return full.endsWith('.html') ? [full] : [];
  });
}

const PLACE_TAG = 'SKQT00000001';
/** A container tag (SPOOL-191): a tag registry row only, on Location 1 (two active shelves). */
const CONTAINER_TAG = 'SKQT00000002';
/** A container tag on Active storage (all three active locations), for a suggestion for a held clip. */
const ACTIVE_TAG = 'SKQT00000003';
/** A clip with no place recorded. */
const NOWHERE_TAG = 'S00000000098';
/** A clip loaded in a printer slot. */
const SLOT_CLIP_TAG = 'S00000000097';
/** A clip whose filament has hostile names. */
const HOSTILE_CLIP_TAG = 'S00000000096';
/** A container tag on Home: every leaf, printer slots included. */
const HOME_TAG = 'SKQT00000004';
/** Names that would become markup if any of them reached innerHTML (all within the 80-character limit). */
const HOSTILE_PLACE = 'S3 "><img src=x id=injected onerror=window.__pwned=1>\u202Eevil';
const HOSTILE_MAKER = '<script id=injected-s>window.__pwned=2</script>';
const HOSTILE_COLOR = 'x" id="injected-a" onmouseover="window.__pwned=3';
const TENANT = '3b1c0d1e-5a1e-4c63-9a0e-5b2a6f0c7d11';
// A throwaway token for this scan only: it protects an in-memory database that lives for seconds.
const CODE = 'A11Y01';
const SCAN_TOKEN = 'a11y-scan-token-0123456789-abcdefghijklmnop';

/** The real app on an in-memory database with the seed and a few items, so states beyond "empty" render. */
async function scanApp() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const sql = sqlFromDatabase(db);
  const seed = JSON.parse(readFileSync('seed/locations-seed.json', 'utf8')) as SeedDocument;
  const schema = JSON.parse(readFileSync('schema/locations-seed.schema.json', 'utf8')) as object;
  await importSeed(sql, TENANT, seed, schema);
  const filament = '00000000-0000-4000-8000-000000000001';
  db.prepare(
    "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, 'Scan', 'PLA', 'Black', 'disposable')",
  ).run(TENANT, filament);
  for (let i = 0; i < 10; i += 1) {
    db.prepare(
      "INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, ?, ?, ?, 'loc1.shelf-1', 'on_spool')",
    ).run(
      TENANT,
      `00000000-0000-4000-8000-${String(i + 10).padStart(12, '0')}`,
      `S${String(i).padStart(11, '0')}`,
      filament,
    );
  }
  // A soft limit that is already over, so the "notice" state renders: 5 boxed spools, room for 4.
  db.prepare('UPDATE location SET capacity = 4 WHERE tenant_id = ? AND id = ?').run(
    TENANT,
    'closet-storage.shelf-1',
  );
  db.prepare(
    "INSERT INTO stock_line (tenant_id, id, filament_id, location_id, pack, count) VALUES (?, '00000000-0000-4000-8000-0000000000aa', ?, 'closet-storage.shelf-1', 'spool', 5)",
  ).run(TENANT, filament);
  // A passive shelf set to a hard limit and already full, so adding boxed stock shows the hard-limit
  // warning. Boxed stock goes on passive storage only (SPOOL-200), so this is where that state lives.
  db.prepare(
    "UPDATE location SET capacity = 1, capacity_mode = 'hard' WHERE tenant_id = ? AND id = ?",
  ).run(TENANT, 'closet-storage.shelf-3');
  db.prepare(
    "INSERT INTO stock_line (tenant_id, id, filament_id, location_id, pack, count) VALUES (?, '00000000-0000-4000-8000-0000000000ab', ?, 'closet-storage.shelf-3', 'spool', 1)",
  ).run(TENANT, filament);
  // A refillable filament too, so a refill pack can be chosen and a disposable one refuses it.
  db.prepare(
    "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, '00000000-0000-4000-8000-000000000002', 'Scan', 'PETG', 'Blue', 'refillable')",
  ).run(TENANT);
  // Tags for the tap page: clips S...1 and S...2 are on loc1.shelf-1 (moved during the scan); two places
  // are tagged; loc1.shelf-2 holds one clip with a capacity of 1, so a move there needs the hard-limit confirm.
  db.prepare('UPDATE location SET tag_id = ? WHERE tenant_id = ? AND id = ?').run(
    PLACE_TAG,
    TENANT,
    'loc1.shelf-1',
  );
  db.prepare('UPDATE location SET capacity = 1 WHERE tenant_id = ? AND id = ?').run(
    TENANT,
    'loc1.shelf-2',
  );
  db.prepare(
    "INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, '00000000-0000-4000-8000-0000000000bb', 'S00000000099', ?, 'loc1.shelf-2', 'on_spool')",
  ).run(TENANT, filament);
  db.prepare(
    "INSERT INTO tag (tenant_id, tag_id, kind, target_id) VALUES (?, ?, 'location', 'loc1')",
  ).run(TENANT, CONTAINER_TAG);
  db.prepare(
    "INSERT INTO tag (tenant_id, tag_id, kind, target_id) VALUES (?, ?, 'location', 'active')",
  ).run(TENANT, ACTIVE_TAG);
  db.prepare(
    "INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, '00000000-0000-4000-8000-0000000000cc', ?, ?, NULL, 'free')",
  ).run(TENANT, NOWHERE_TAG, filament);
  db.prepare(
    "INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, '00000000-0000-4000-8000-0000000000dd', ?, ?, 'dreammaker.ams-a.slot-1', 'on_spool')",
  ).run(TENANT, SLOT_CLIP_TAG, filament);
  db.prepare(
    "INSERT INTO tag (tenant_id, tag_id, kind, target_id) VALUES (?, ?, 'location', 'home')",
  ).run(TENANT, HOME_TAG);
  // Hostile names: a place inside Active storage and a filament with a clip on another active shelf.
  db.prepare('UPDATE location SET name = ? WHERE tenant_id = ? AND id = ?').run(
    HOSTILE_PLACE,
    TENANT,
    'loc3.shelf-3',
  );
  db.prepare(
    "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, '00000000-0000-4000-8000-000000000003', ?, 'PLA', ?, 'disposable')",
  ).run(TENANT, HOSTILE_MAKER, HOSTILE_COLOR);
  db.prepare(
    "INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, '00000000-0000-4000-8000-0000000000ee', ?, '00000000-0000-4000-8000-000000000003', 'loc2.shelf-4', 'on_spool')",
  ).run(TENANT, HOSTILE_CLIP_TAG);
  // The real app with the real static handler, so the CSP header and module scripts are exercised.
  return createApp({
    auth: createDevTokenProvider({ token: SCAN_TOKEN, tenantId: TENANT }),
    data: (principal) => createScopedData(sql, principal),
    allowedHosts: ['127.0.0.1'],
    staticHandler: serveStatic({ root: './app/public' }),
    sessions: createMemorySessionStore(),
    tagPages: { instanceCode: CODE, shell: readFileSync('app/public/tap.html', 'utf8') },
  });
}

/** A behaviour check in the real page: returns 1 (and reports) when the text is missing. */
function expectText(actual: string, expected: string, what: string): number {
  if (actual.includes(expected)) return 0;
  console.error(`::error::expected "${expected}" (${what}) but the page showed: ${actual}`);
  return 1;
}

/** WCAG 1.4.10 Reflow: at 320px wide with text enlarged, the page must not scroll sideways. */
async function reflow(tab: Page, label: string): Promise<number> {
  const size = tab.viewportSize();
  await tab.setViewportSize({ width: 320, height: 700 });
  await tab.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  // Let the resize and the new text size settle before measuring.
  await tab.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );
  const overflow = await tab.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  const widest = await tab.evaluate(() =>
    [...document.querySelectorAll('body *')]
      .map((e) => ({ e, right: e.getBoundingClientRect().right }))
      .sort((a, b) => b.right - a.right)
      .slice(0, 3)
      .map(
        ({ e, right }) => `${e.tagName.toLowerCase()}#${e.id} right=${String(Math.round(right))}`,
      )
      .join(', '),
  );
  await tab.evaluate(() => {
    document.documentElement.style.fontSize = '';
  });
  if (size) await tab.setViewportSize(size);
  if (overflow <= 0) return 0;
  console.error(
    `::error::${label}: the page scrolls sideways by ${String(overflow)}px (widest: ${widest})`,
  );
  return 1;
}

async function axe(tab: Page, label: string): Promise<number> {
  const result = await new AxeBuilder({ page: tab }).withTags(TAGS).analyze();
  for (const v of result.violations) {
    console.error(`::error::${label}: ${v.id} (${v.impact ?? 'n/a'}): ${v.help} - ${v.helpUrl}`);
  }
  return result.violations.length;
}

const pages = htmlFiles(root).map((f) => `/${relative(root, f)}`);
if (pages.length === 0) {
  console.error(`No HTML pages found under ${root}; the accessibility gate would check nothing.`);
  process.exit(1);
}

const app = await scanApp();
let server: ReturnType<typeof serve> | undefined;
const port = await new Promise<number>((resolve) => {
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info: AddressInfo) => {
    resolve(info.port);
  });
});

const executablePath = process.env.CHROME_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : { channel: 'chrome' });
let violations = 0;
try {
  for (const page of pages) {
    const context = await browser.newContext();
    const tab = await context.newPage();
    await tab.goto(`http://127.0.0.1:${String(port)}${page}`);
    const result = await new AxeBuilder({ page: tab }).withTags(TAGS).analyze();
    for (const v of result.violations) {
      violations += 1;
      console.error(`::error::${page}: ${v.id} (${v.impact ?? 'n/a'}): ${v.help} - ${v.helpUrl}`);
    }
    await context.close();
  }

  // The page with data: the real app, a real browser, tapping through the states a person sees.
  for (const scheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({
      colorScheme: scheme,
      viewport: { width: 375, height: 700 },
    });
    const tab = await context.newPage();
    await tab.goto(`http://127.0.0.1:${String(port)}/`);
    await tab.fill('#token', SCAN_TOKEN);
    await tab.click('button[type=submit]');
    await tab.waitForSelector('#place-result:not(:empty)');
    await tab.waitForSelector('#tree li');
    violations += await axe(tab, `/ (${scheme}, tree collapsed)`);
    violations += await reflow(tab, `/ (${scheme}, 320px wide, text at 200%, tree collapsed)`);
    // Collapsed containers must show a cue that they open: the summary marker is generated content.
    const cue = await tab
      .locator('#tree details:not([open]) > summary')
      .first()
      .evaluate((el) => getComputedStyle(el, '::before').content);
    violations += expectText(cue, '▸', 'a collapsed container shows a visible cue that it opens');
    // Open every container by tapping its summary, deepest last, the way a person would.
    for (let guard = 0; guard < 100; guard += 1) {
      const closed = tab.locator('#tree details:not([open]) > summary');
      if ((await closed.count()) === 0) break;
      await closed.first().click();
    }
    violations += await axe(tab, `/ (${scheme}, tree expanded)`);
    violations += await reflow(tab, `/ (${scheme}, 320px wide, text at 200%, tree expanded)`);
    violations += expectText(
      await tab.locator('#tree').innerText(),
      '6 free of 16 (10 used)',
      'a 16-place shelf with 10 items shows 6 free',
    );
    violations += expectText(
      await tab.locator('#tree').innerText(),
      'Capacity not set',
      'a leaf without capacity says so',
    );
    // 16 places, 10 used: pick 7 to go over the hard limit and show the warning state.
    await tab.selectOption('#place-location', 'loc1.shelf-1');
    for (let i = 0; i < 6; i += 1) await tab.click('#place-more');
    await tab.locator('#place-result[data-outcome="warning"]').waitFor();
    violations += await axe(tab, `/ (${scheme}, hard-limit warning)`);
    violations += expectText(
      await tab.locator('#place-result').innerText(),
      'Warning',
      'a hard limit shows a warning',
    );
    await tab.selectOption('#place-location', 'closet-storage.shelf-1');
    await tab.locator('#place-result[data-outcome="notice"]').waitFor();
    violations += await axe(tab, `/ (${scheme}, soft-limit notice)`);
    violations += expectText(
      await tab.locator('#place-result').innerText(),
      'Notice',
      'a soft limit allows with a notice',
    );
    await tab.selectOption('#place-location', 'closet-storage.shelf-2');
    await tab.locator('#place-result[data-outcome="capacity_not_set"]').waitFor();
    violations += await axe(tab, `/ (${scheme}, capacity not set)`);
    violations += expectText(
      await tab.locator('#place-result').innerText(),
      'not set',
      'capacity not set is shown for placement',
    );
    // Neither a leaf with no capacity nor one already over its limit is suggested.
    const suggested = await tab.locator('#place-suggestions').innerText();
    violations += suggested.includes('Storage closet') ? 1 : 0;
    // A whole container: "can I put it in the Storage closet?" counts only the shelves with a capacity.
    await tab.selectOption('#place-location', 'closet-storage');
    await tab
      .locator('#place-result[data-outcome="notice"]:has-text("have no capacity set")')
      .waitFor();
    violations += await axe(tab, `/ (${scheme}, container with capacity not set inside)`);
    violations += expectText(
      await tab.locator('#place-result').innerText(),
      'not counted',
      'a container says which places were left out of the count',
    );
    violations += (await tab.locator('#place-suggestions').innerText()).includes('Location 1')
      ? 1
      : 0;
    await tab.selectOption('#place-location', 'home');
    await tab.locator('#place-result:has-text("in total")').waitFor();
    violations += await axe(tab, `/ (${scheme}, Home as the place)`);
    // The non-NFC way to move a clip: pick the place, tap a clip, see the mover panel.
    await tab.selectOption('#move-from', 'loc1.shelf-1');
    await tab.locator('#move-clips li button').first().waitFor();
    violations += await axe(tab, `/ (${scheme}, move section, clips listed)`);
    await tab.locator('#move-clips li button').first().click();
    await tab.locator('#mover-go').waitFor();
    violations += await axe(tab, `/ (${scheme}, move section, mover open)`);
    violations += await reflow(tab, `/ (${scheme}, 320px wide, text at 200%, mover open)`);
    // Boxed stock: a place with a count, +/- taps, adding by choosing, the hard-limit warning, where is it.
    // Only passive storage is offered for boxed stock (SPOOL-200): no active shelf, slot or clip bin.
    const offered = await tab
      .locator('#stock-place option')
      .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    for (const notOffered of ['loc1.shelf-2', 'clips.bin-1', 'dreammaker.ams-a.slot-1']) {
      if (offered.includes(notOffered)) {
        console.error(
          `::error::the boxed stock picker offers ${notOffered}, which is not passive storage`,
        );
        violations += 1;
      }
    }
    if (offered.length !== 14) {
      console.error(
        `::error::the boxed stock picker offers ${String(offered.length)} places, not the 14 passive ones`,
      );
      violations += 1;
    }
    await tab.selectOption('#stock-place', 'closet-storage.shelf-1');
    await tab.locator('#stock-lines li output').first().waitFor();
    violations += expectText(
      await tab.locator('#stock-lines').innerText(),
      'Scan PLA Black',
      'the stock list names the filament',
    );
    violations += await axe(tab, `/ (${scheme}, boxed stock listed)`);
    violations += await reflow(tab, `/ (${scheme}, 320px wide, text at 200%, boxed stock)`);
    await tab
      .locator('#stock-lines li', { hasText: 'Scan PLA Black' })
      .getByRole('button', { name: /Plus: one more/ })
      .click();
    await tab.locator('#stock-status:has-text("now 6")').waitFor();
    await tab
      .locator('#stock-lines li', { hasText: 'Scan PLA Black' })
      .getByRole('button', { name: /Minus: one fewer/ })
      .click();
    await tab.locator('#stock-status:has-text("now 5")').waitFor();
    violations += await axe(tab, `/ (${scheme}, boxed stock after taps)`);
    await tab.selectOption('#add-mfr', 'Scan');
    await tab.selectOption('#add-type', 'PETG');
    await tab.selectOption('#add-color', { label: 'Blue' });
    violations += expectText(
      await tab.locator('#add-pack').innerText(),
      'Refill pack',
      'a refillable filament offers a refill pack',
    );
    violations += (await tab.locator('#add-pack option[value=refill]').isDisabled()) ? 1 : 0;
    await tab.selectOption('#add-pack', 'refill');
    await tab.click('#add-go');
    await tab.locator('#stock-status:has-text("Added")').waitFor();
    violations += await axe(tab, `/ (${scheme}, filament added)`);
    await tab
      .locator('#stock-lines li', { hasText: 'Refill' })
      .getByRole('button', { name: /Minus: one fewer/ })
      .click();
    await tab.locator('#stock-status:has-text("now 0")').waitFor();
    await tab.selectOption('#add-type', 'PLA');
    await tab.selectOption('#add-color', { label: 'Black' });
    violations += (await tab.locator('#add-pack option[value=refill]').isDisabled()) ? 0 : 1;
    await tab.selectOption('#stock-place', 'closet-storage.shelf-3');
    await tab.click('#add-go');
    await tab.locator('#stock-anyway:not([hidden])').waitFor();
    violations += expectText(
      await tab.locator('#stock-warning').innerText(),
      'hard limit',
      'a full hard place warns before adding stock',
    );
    violations += await axe(tab, `/ (${scheme}, boxed stock hard-limit warning)`);
    await tab.selectOption('#where-filament', { label: 'Scan PLA Black' });
    await tab.locator('#where-lines li').first().waitFor();
    violations += await axe(tab, `/ (${scheme}, where is it)`);
    await context.close();
  }

  // The tag page: sign in, a clip card, holding it, the hard-limit warning, a move, a place card, and the
  // neutral pages. Each scheme uses its own clip so the two runs do not depend on each other.
  const tapBase = `http://127.0.0.1:${String(port)}`;
  // The API's suggestion for a container tag, asked from inside the page (same session cookie).
  const apiSuggestion = (tab: Page, tag: string, held?: string) =>
    tab.evaluate(
      async ([t, h]) => {
        const query = h ? `?held=${h}` : '';
        const r = await fetch(`/api/v1/tags/${t}${query}`, { cache: 'no-store' });
        const v = (await r.json()) as { suggestion: { location_id: string; name: string } | null };
        return v.suggestion;
      },
      [tag, held ?? ''] as const,
    );
  /** Nothing from a hostile name became an element or ran; the name is shown as literal text. */
  const noInjection = async (tab: Page, label: string, literal: string): Promise<number> => {
    const found = await tab.evaluate(() => ({
      elements: document.querySelectorAll(
        '#injected, #injected-s, #injected-a, main img, main script',
      ).length,
      ran: (window as unknown as { __pwned?: number }).__pwned ?? 0,
      text: document.querySelector('main')?.textContent ?? '',
    }));
    let bad = 0;
    if (found.elements > 0 || found.ran !== 0) {
      console.error(
        `::error::${label}: a hostile name became markup (${String(found.elements)} element(s), ran ${String(found.ran)})`,
      );
      bad += 1;
    }
    return bad + expectText(found.text, literal, `${label}: the hostile name is shown as text`);
  };
  /** Before the person confirms, the status line must not say anything moved (no optimistic text). */
  const notMovedYet = async (tab: Page, scheme: string): Promise<number> => {
    const said = await tab.locator('#tap-status').innerText();
    if (!said.includes('Moved')) return 0;
    console.error(
      `::error::tap (${scheme}): the page said "${said}" before the move was confirmed`,
    );
    return 1;
  };
  /** Puts a held clip in this browser's storage, as another tab would. */
  const setHeld = (tab: Page, id: string, label: string, from: string | null) =>
    tab.evaluate(
      ([i, l, f]) => {
        localStorage.setItem(
          'spoolspot.held-clip',
          JSON.stringify({ id: i, label: l, from: f, at: Date.now() }),
        );
      },
      [id, label, from] as const,
    );
  const heldId = (tab: Page) =>
    tab.evaluate(() => {
      const raw = localStorage.getItem('spoolspot.held-clip');
      return raw ? (JSON.parse(raw) as { id: string }).id : '';
    });
  for (const [scheme, clipTag, heldTag, fullTag] of [
    ['light', 'S00000000001', 'S00000000003', 'S00000000005'],
    ['dark', 'S00000000002', 'S00000000004', 'S00000000006'],
  ] as const) {
    const context = await browser.newContext({
      colorScheme: scheme,
      viewport: { width: 375, height: 700 },
    });
    const tab = await context.newPage();
    await tab.goto(`${tapBase}/${CODE}${clipTag}`);
    await tab.locator('#signin:not([hidden])').waitFor();
    violations += await axe(tab, `tap (${scheme}, sign in)`);
    violations += await reflow(tab, `tap (${scheme}, 320px wide, text at 200%, sign in)`);
    await tab.fill('#token', SCAN_TOKEN);
    await tab.click('#signin button[type=submit]');
    await tab.locator('#tag-card:not([hidden])').waitFor();
    violations += expectText(
      await tab.locator('#tag-heading').innerText(),
      'Clip: Scan PLA Black',
      'a clip tag shows its filament',
    );
    // The owner's scenario: the clip's tag says where it belongs, with the containers above it.
    violations += expectText(
      await tab.locator('#clip-place').innerText(),
      'This clip belongs at Location 1 - Shelf 1.',
      'a clip tag says where the clip belongs',
    );
    violations += expectText(
      await tab.locator('#tag-body ol.path').innerText(),
      'Active storage',
      'a clip tag shows the chain of containers above its place',
    );
    violations += await axe(tab, `tap (${scheme}, clip card)`);
    violations += await reflow(tab, `tap (${scheme}, 320px wide, text at 200%, clip card)`);
    await tab.click('#pick-up');
    await tab.locator('#mover-go').waitFor();
    violations += await axe(tab, `tap (${scheme}, mover open)`);
    violations += await reflow(tab, `tap (${scheme}, 320px wide, text at 200%, mover open)`);
    // A full hard place: the page warns and asks again before it moves anything.
    await tab.selectOption('#mover-place', 'loc1.shelf-2');
    await tab.click('#mover-go');
    await tab.locator('#mover-anyway:not([hidden])').waitFor();
    violations += expectText(
      await tab.locator('#mover-warning').innerText(),
      'hard limit',
      'a hard limit warns before moving',
    );
    violations += await axe(tab, `tap (${scheme}, hard-limit warning)`);
    await tab.selectOption('#mover-place', 'closet-storage.shelf-1');
    await tab.click('#mover-go');
    await tab.locator('#tap-status:has-text("Moved.")').waitFor();
    violations += expectText(
      await tab.locator('#tap-status').innerText(),
      'is now at Storage closet - Shelf 1 (Home, Passive storage, Storage closet)',
      'after a move the page states the new place and its chain',
    );
    violations += expectText(
      await tab.locator('#clip-place').innerText(),
      'Storage closet - Shelf 1',
      'after a move the clip card shows the new place',
    );
    violations += await axe(tab, `tap (${scheme}, moved)`);
    await tab.goto(`${tapBase}/${CODE}${PLACE_TAG}`);
    await tab.locator('#clip-list-section:not([hidden])').waitFor();
    violations += expectText(
      await tab.locator('#tag-detail').innerText(),
      'free of',
      'a place tag shows used and free',
    );
    violations += await axe(tab, `tap (${scheme}, place card)`);
    violations += await reflow(tab, `tap (${scheme}, 320px wide, text at 200%, place card)`);
    violations += expectText(
      await tab.locator('#tag-body ol.path').innerText(),
      'Location 1',
      'a place tag shows the chain of containers above it',
    );
    // The non-NFC way to the same views: choose a container from the list on the tap page.
    await tab.selectOption('#browse-place', 'loc1');
    await tab.locator('#tap-status:has-text("Showing Location 1.")').waitFor();
    violations += expectText(
      await tab.locator('#inside-list').innerText(),
      'Location 1 - Shelf 2',
      'a container chosen from the list shows the places inside',
    );
    violations += await axe(tab, `tap (${scheme}, container chosen from the list)`);
    violations += await reflow(
      tab,
      `tap (${scheme}, 320px wide, text at 200%, container chosen from the list)`,
    );
    // A container tag: the card must render (not "data this page does not understand").
    await tab.goto(`${tapBase}/${CODE}${CONTAINER_TAG}`);
    await tab.waitForFunction(() => {
      const shown = document.getElementById('tag-card')?.hidden === false;
      const said = document.getElementById('tap-status')?.textContent ?? '';
      return shown || (said !== '' && said !== 'Loading…');
    });
    violations += expectText(
      (await tab.locator('#tag-card').isVisible())
        ? await tab.locator('#tag-heading').innerText()
        : `(no card) ${await tab.locator('#tap-status').innerText()}`,
      'Location 1',
      'a container tag shows the container name',
    );
    // Nothing held: the API's most-room suggestion is at the top, in words.
    const most = await apiSuggestion(tab, CONTAINER_TAG);
    violations += expectText(
      await tab.locator('#suggestion-text').innerText(),
      most ? `Suggested: ${most.name} (` : '(the API gave no suggestion)',
      'a container tag shows the API suggestion at the top',
    );
    violations += await axe(tab, `tap (${scheme}, container card with a suggestion)`);
    violations += await reflow(tab, `tap (${scheme}, 320px wide, text at 200%, container card)`);

    // A clip with no place recorded says so plainly.
    await tab.goto(`${tapBase}/${CODE}${NOWHERE_TAG}`);
    await tab.locator('#clip-place').waitFor();
    violations += expectText(
      await tab.locator('#clip-place').innerText(),
      'No place is recorded for this clip.',
      'a clip with no place says so',
    );
    violations += await axe(tab, `tap (${scheme}, clip with no place)`);

    // Holding a clip, then tapping a container: the best place for it, confirmed with taps only.
    await tab.goto(`${tapBase}/${CODE}${heldTag}`);
    await tab.click('#pick-up');
    await tab.locator('#mover-go').waitFor();
    const held = await heldId(tab);
    // A stale or altered stored place that claims a slot: the server used the clip and returned a
    // suggestion, so the page shows it with its buttons (the slot claim is not trusted alone).
    await setHeld(tab, held, 'Scan PLA Black', 'dreammaker.ams-a.slot-1');
    await tab.goto(`${tapBase}/${CODE}${ACTIVE_TAG}`);
    await tab.locator('#suggestion-go').waitFor();
    violations += (await tab.locator('#inside-list button').count()) > 0 ? 0 : 1;
    // WCAG 2.5.3: the suggestion button's accessible name contains its visible label.
    const go = await tab
      .locator('#suggestion-go')
      .evaluate((b) => ({ shown: b.textContent, name: b.getAttribute('aria-label') ?? '' }));
    if (!go.name.startsWith(go.shown) || /[\u2066-\u2069]/u.test(go.name)) {
      console.error(`::error::the suggestion button is named "${go.name}" for "${go.shown}"`);
      violations += 1;
    }
    const best = await apiSuggestion(tab, ACTIVE_TAG, held);
    violations += expectText(
      await tab.locator('#suggestion-text').innerText(),
      best ? `Suggested: ${best.name} (` : '(the API gave no suggestion)',
      'the held clip’s suggestion is the API’s',
    );
    violations += expectText(
      await tab.locator('#inside-list li.suggested').innerText(),
      best?.name ?? '(none)',
      'the suggested place is marked in the list in words',
    );
    violations += await axe(tab, `tap (${scheme}, container with a suggestion for a held clip)`);
    // A hostile place name inside: literal text, in its own <bdi>, and nothing injected or run.
    violations += await noInjection(tab, `tap (${scheme}, hostile place name)`, '"><img src=x');
    violations += (await tab.locator('#inside-list li span bdi').count()) > 0 ? 0 : 1;
    violations += await reflow(
      tab,
      `tap (${scheme}, 320px wide, text at 200%, container with a held clip)`,
    );
    await tab.click('#suggestion-go');
    // The suggestion goes through the shared mover: nothing moves until "Move here" is tapped.
    await tab.locator('#mover-go').waitFor();
    violations += await notMovedYet(tab, scheme);
    violations += (await tab.locator('#mover-place').inputValue()) === best?.location_id ? 0 : 1;
    await tab.click('#mover-go');
    await tab.locator('#tap-status:has-text("Moved.")').waitFor();
    violations += expectText(
      await tab.locator('#tap-status').innerText(),
      `is now at ${best?.name ?? '(none)'} (Home, Active storage,`,
      'after a move from a container the page states the new place and its chain',
    );
    violations += await axe(tab, `tap (${scheme}, after a move from a container)`);

    // A clip whose filament has hostile names: shown as literal text, nothing injected or run.
    await tab.goto(`${tapBase}/${CODE}${HOSTILE_CLIP_TAG}`);
    await tab.locator('#clip-place').waitFor();
    violations += await noInjection(tab, `tap (${scheme}, hostile filament name)`, HOSTILE_MAKER);
    violations += await axe(tab, `tap (${scheme}, hostile filament name)`);

    // A held clip loaded in a printer slot: the container says so and offers no Choose.
    await tab.goto(`${tapBase}/${CODE}${SLOT_CLIP_TAG}`);
    await tab.click('#pick-up');
    await tab.locator('#mover-go').waitFor();
    await tab.goto(`${tapBase}/${CODE}${CONTAINER_TAG}`);
    await tab.locator('#suggestion-text').waitFor();
    violations += expectText(
      await tab.locator('#suggestion-text').innerText(),
      'is loaded in a printer slot. Unload it from the printer first',
      'a held clip in a slot is told to be unloaded first',
    );
    violations += (await tab.locator('#inside-list button, #suggestion-go').count()) === 0 ? 0 : 1;
    violations += await axe(tab, `tap (${scheme}, container, held clip in a slot)`);

    // A held clip the server does not know: not presented as ranked for it; no Choose.
    await setHeld(tab, '00000000-0000-4000-8000-00000000ffff', 'Gone PLA Grey', 'loc1.shelf-1');
    await tab.goto(`${tapBase}/${CODE}${ACTIVE_TAG}`);
    await tab.locator('#suggestion-text').waitFor();
    violations += expectText(
      await tab.locator('#suggestion-text').innerText(),
      'was not found here. Tap its tag again to hold it.',
      'a held clip the server does not know is said to be not found',
    );
    violations += (await tab.locator('#suggestion').innerText()).includes('Best place') ? 1 : 0;
    violations += (await tab.locator('#inside-list button, #suggestion-go').count()) === 0 ? 0 : 1;
    violations += await axe(tab, `tap (${scheme}, container, held clip not found)`);

    // Holding a clip where nothing inside suits it: no suggestion; choosing a full hard place warns.
    await tab.goto(`${tapBase}/${CODE}${fullTag}`);
    await tab.click('#pick-up');
    await tab.locator('#mover-go').waitFor();
    // Slots are never choosable: on Home (every leaf), no slot row has a button, other rows do.
    await tab.goto(`${tapBase}/${CODE}${HOME_TAG}`);
    await tab.locator('#inside-list button').first().waitFor();
    const slotButtons = await tab
      .locator('#inside-list li', { hasText: 'Printer slot' })
      .locator('button')
      .count();
    const slotRows = await tab.locator('#inside-list li', { hasText: 'Printer slot' }).count();
    if (slotButtons > 0 || slotRows === 0) {
      console.error(
        `::error::slots must be listed without a Choose button (${String(slotRows)} rows, ${String(slotButtons)} buttons)`,
      );
      violations += 1;
    }
    await tab.goto(`${tapBase}/${CODE}${CONTAINER_TAG}`);
    await tab.locator('#inside-list button').first().waitFor();
    violations += expectText(
      await tab.locator('#suggestion-text').innerText(),
      'No place inside suits',
      'a container with nothing suitable says so',
    );
    violations += await axe(tab, `tap (${scheme}, container without a suggestion)`);
    // Another clip is picked up elsewhere (another tab): a Choose redraws for it instead of moving.
    await setHeld(tab, '00000000-0000-4000-8000-000000000017', 'Scan PLA Black', 'loc1.shelf-1');
    await tab.getByRole('button', { name: 'Choose Location 1 - Shelf 1', exact: true }).click();
    await tab.locator('#tap-status:has-text("The held clip changed to")').waitFor();
    violations += (await tab.locator('#mover-go').isVisible()) ? 1 : 0;
    violations += await axe(tab, `tap (${scheme}, held clip changed)`);
    // Found by its plain accessible name (no hidden characters in it).
    await tab.getByRole('button', { name: 'Choose Location 1 - Shelf 2', exact: true }).click();
    await tab.click('#mover-go');
    await tab.locator('#mover-anyway:not([hidden])').waitFor();
    violations += expectText(
      await tab.locator('#mover-warning').innerText(),
      'hard limit',
      'a full hard place chosen from a container warns before moving',
    );
    // Nothing is said to have moved while the confirm is pending.
    violations += await notMovedYet(tab, scheme);
    violations += await axe(tab, `tap (${scheme}, container move hard-limit warning)`);
    await tab.click('#mover-cancel');
    // Unknown tag of this instance and a wrong instance code: the same neutral message. Exactly one
    // API request is made for an unknown tag (the lookup): nothing else is asked for.
    const apiCalls: string[] = [];
    const record = (r: { url(): string }) => {
      const path = new URL(r.url()).pathname;
      if (path.startsWith('/api/')) apiCalls.push(path);
    };
    tab.on('request', record);
    await tab.goto(`${tapBase}/${CODE}SKQT0000ZZZZ`);
    await tab.locator('#tap-status:has-text("not recognised")').waitFor();
    await tab.waitForLoadState('networkidle');
    tab.off('request', record);
    if (apiCalls.join(' ') !== '/api/v1/tags/SKQT0000ZZZZ') {
      console.error(`::error::an unknown tag made these API requests: ${apiCalls.join(', ')}`);
      violations += 1;
    }
    violations += (await tab.locator('#browse').isVisible()) ? 1 : 0;
    violations += (await tab.locator('#tag-card').isVisible()) ? 1 : 0;
    violations += await axe(tab, `tap (${scheme}, unknown tag)`);
    const wrong = await tab.goto(`${tapBase}/ZZZZZZSKQT0000ZZZZ`);
    violations += wrong?.status() === 404 ? 0 : 1;
    violations += expectText(
      await tab.locator('body').innerText(),
      'not recognised',
      'a wrong code shows the neutral page',
    );
    violations += await axe(tab, `tap (${scheme}, wrong instance code)`);
    await context.close();
  }
} finally {
  await browser.close();
  server?.close();
}

if (violations > 0) process.exit(1);
console.log(
  `${String(pages.length)} page(s), the loaded tree and placement states, the move section, boxed stock and the tag page states including a container tag (light and dark) passed the axe-core WCAG 2.2 A/AA scan.`,
);
