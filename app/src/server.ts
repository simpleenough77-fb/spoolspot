// SPDX-License-Identifier: AGPL-3.0-or-later
// Node entry point. Usage: SPOOLSPOT_DEV_TOKEN=<32+ chars> node app/src/server.ts
// DEV ONLY until SPOOL-175 lands: plain HTTP and one fixed token (failed sign-ins and tag lookups are
// rate limited per connecting address, an address a reverse proxy would hide).
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { relative, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createDevTokenProvider } from './auth/dev-token.ts';
import { createMemorySessionStore } from './auth/session.ts';
import { isLoopback, loadConfig } from './config.ts';
import { createScopedData } from './data/scoped.ts';
import { runMigrations } from './db/migrate.ts';
import { openDatabase, sqlFromDatabase } from './db/sqlite.ts';
import { createApp } from './http/app.ts';
import { clientKeyFor } from './http/rate-limit.ts';

const config = loadConfig(process.env);
let auth;
try {
  auth = createDevTokenProvider({ token: config.devToken, tenantId: config.tenantId });
} catch (error) {
  console.error(`SPOOLSPOT_DEV_TOKEN: ${error instanceof Error ? error.message : 'invalid'}`);
  process.exit(1);
}

if (!isLoopback(config.host) && !config.allowLan) {
  console.error(
    `Refusing to listen on ${config.host}: this development build uses plain HTTP and one shared token. ` +
      'Set SPOOLSPOT_ALLOW_LAN=1 to allow it on a trusted home network.',
  );
  process.exit(1);
}

const db = openDatabase(config.databasePath);
const applied = runMigrations(db);
const sql = sqlFromDatabase(db);

// The page a tag opens (ADR-0001 phase 1: this server is the resolver). Off unless an instance code is set.
const shellPath = resolve(import.meta.dirname, '../public/tap.html');
const tagPages = config.instanceCode
  ? { instanceCode: config.instanceCode, shell: readFileSync(shellPath, 'utf8') }
  : undefined;

const app = createApp({
  auth,
  sessions: createMemorySessionStore(),
  ...(tagPages ? { tagPages } : {}),
  // The connecting address, for rate limiting only. It is not logged or stored beyond the window.
  clientKey: (c) =>
    clientKeyFor((c.env as { incoming?: IncomingMessage }).incoming?.socket.remoteAddress),
  ...(config.secureCookies === undefined ? {} : { secureCookies: config.secureCookies }),
  data: (principal) => createScopedData(sql, principal),
  allowedHosts: config.allowedHosts,
  staticHandler: serveStatic({
    root: relative(process.cwd(), resolve(import.meta.dirname, '../public')) || '.',
  }),
});

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`SpoolSpot (dev) listening on http://${info.address}:${String(info.port)}`);
  if (applied.length > 0) console.log(`applied migrations: ${applied.join(', ')}`);
  console.log(
    tagPages
      ? `tag links: http://<host>:${String(info.port)}/${tagPages.instanceCode}<tag id>`
      : 'tag links are off: set SPOOLSPOT_INSTANCE_CODE (6 characters) to turn them on',
  );
  if (!isLoopback(config.host)) {
    console.warn(
      'WARNING: listening beyond this computer over plain HTTP with the dev token. Use only on a trusted home network.',
    );
    console.warn(`Answering to host names: ${config.allowedHosts.join(', ')}`);
  }
});

function shutdown(): void {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
