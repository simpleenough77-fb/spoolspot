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
    await context.close();
  }

  // The tag page: sign in, a clip card, holding it, the hard-limit warning, a move, a place card, and the
  // neutral pages. Each scheme uses its own clip so the two runs do not depend on each other.
  const tapBase = `http://127.0.0.1:${String(port)}`;
  for (const [scheme, clipTag] of [
    ['light', 'S00000000001'],
    ['dark', 'S00000000002'],
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
    violations += await axe(tab, `tap (${scheme}, clip card)`);
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
    // Unknown tag of this instance and a wrong instance code: the same neutral message.
    await tab.goto(`${tapBase}/${CODE}SKQT0000ZZZZ`);
    await tab.locator('#tap-status:has-text("not recognised")').waitFor();
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
  `${String(pages.length)} page(s), the loaded tree and placement states, the move section and the tag page states (light and dark) passed the axe-core WCAG 2.2 A/AA scan.`,
);
