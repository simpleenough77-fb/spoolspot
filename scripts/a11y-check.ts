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
import { join, relative } from 'node:path';
import { chromium } from 'playwright-core';

const root = 'app/public';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

function htmlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return htmlFiles(full);
    return full.endsWith('.html') ? [full] : [];
  });
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
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
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
} finally {
  await browser.close();
  server.close();
}

if (violations > 0) process.exit(1);
console.log(`${String(pages.length)} page(s) passed the axe-core WCAG 2.2 A/AA scan.`);
