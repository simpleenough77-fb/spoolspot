// SPDX-License-Identifier: AGPL-3.0-or-later
// CI check: automated WCAG 2.2 A/AA scan (axe-core) of every HTML page under app/public.
// Automated checks find only part of the issues; the manual checklist still applies to changed UI.
//
// Browser: set CHROME_PATH to a Chrome/Chromium binary, or leave it unset to use the installed
// Google Chrome ("chrome" channel), which GitHub's ubuntu runners include.
import { AxeBuilder } from '@axe-core/playwright';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, relative } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { createDevTokenProvider } from '../app/src/auth/dev-token.ts';
import { createScopedData } from '../app/src/data/scoped.ts';
import { runMigrations } from '../app/src/db/migrate.ts';
import { openDatabase, sqlFromDatabase } from '../app/src/db/sqlite.ts';
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

// Browsers refuse a stylesheet served with the wrong type, which would make the contrast checks meaningless.
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
function contentType(file: string): string {
  return TYPES[extname(file)] ?? 'application/octet-stream';
}

const TENANT = '3b1c0d1e-5a1e-4c63-9a0e-5b2a6f0c7d11';
// A throwaway token for this scan only: it protects an in-memory database that lives for seconds.
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
  return createApp({
    auth: createDevTokenProvider({ token: SCAN_TOKEN, tenantId: TENANT }),
    data: (principal) => createScopedData(sql, principal),
    allowedHosts: ['127.0.0.1'],
  });
}

/** A behaviour check in the real page: returns 1 (and reports) when the text is missing. */
function expectText(actual: string, expected: string, what: string): number {
  if (actual.includes(expected)) return 0;
  console.error(`::error::expected "${expected}" (${what}) but the page showed: ${actual}`);
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

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  const file = join(root, path === '/' ? 'index.html' : path);
  if (relative(root, file).startsWith('..')) {
    res.writeHead(403).end();
    return;
  }
  let body: Buffer;
  try {
    body = readFileSync(file);
  } catch {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': contentType(file) });
  res.end(body);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;

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

  // The page with data: real API, real browser, tapping through the states a person sees.
  const app = await scanApp();
  for (const scheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({
      colorScheme: scheme,
      viewport: { width: 375, height: 700 },
    });
    await context.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      const response = await app.request(`http://127.0.0.1${url.pathname}${url.search}`, {
        headers: { host: '127.0.0.1', ...route.request().headers() },
      });
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      });
    });
    const tab = await context.newPage();
    await tab.goto(`http://127.0.0.1:${String(port)}/`);
    await tab.fill('#token', SCAN_TOKEN);
    await tab.click('button[type=submit]');
    await tab.waitForSelector('#place-result:not(:empty)');
    await tab.waitForSelector('#tree li');
    await tab.evaluate(
      "document.querySelectorAll('#tree details').forEach((d) => { d.open = true; })",
    );
    violations += await axe(tab, `/ (${scheme}, tree expanded)`);
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
    await tab.waitForFunction(
      "document.getElementById('place-result')?.dataset.outcome === 'warning'",
    );
    violations += await axe(tab, `/ (${scheme}, hard-limit warning)`);
    violations += expectText(
      await tab.locator('#place-result').innerText(),
      'Warning',
      'a hard limit shows a warning',
    );
    await tab.selectOption('#place-location', 'closet-storage.shelf-1');
    await tab.waitForFunction(
      "document.getElementById('place-result')?.dataset.outcome === 'capacity_not_set'",
    );
    violations += await axe(tab, `/ (${scheme}, capacity not set)`);
    violations += expectText(
      await tab.locator('#place-result').innerText(),
      'not set',
      'capacity not set is shown for placement',
    );
    const suggested = await tab.locator('#place-suggestions').innerText();
    violations += suggested.includes('Storage closet') ? 1 : 0;
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}

if (violations > 0) process.exit(1);
console.log(
  `${String(pages.length)} page(s) and the loaded tree and placement states (light and dark) passed the axe-core WCAG 2.2 A/AA scan.`,
);
