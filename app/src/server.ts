// SPDX-License-Identifier: AGPL-3.0-or-later
// Node entry point. Usage: SPOOLSPOT_DEV_TOKEN=<32+ chars> node app/src/server.ts
// DEV ONLY until SPOOL-175 lands: plain HTTP, one fixed token, no rate limiting.
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createDevTokenProvider } from './auth/dev-token.ts';
import { isLoopback, loadConfig } from './config.ts';
import { createScopedData } from './data/scoped.ts';
import { runMigrations } from './db/migrate.ts';
import { openDatabase, sqlFromDatabase } from './db/sqlite.ts';
import { createApp } from './http/app.ts';

const config = loadConfig(process.env);
let auth;
try {
  auth = createDevTokenProvider({ token: config.devToken, tenantId: config.tenantId });
} catch (error) {
  console.error(`SPOOLSPOT_DEV_TOKEN: ${error instanceof Error ? error.message : 'invalid'}`);
  process.exit(1);
}

const db = openDatabase(config.databasePath);
const applied = runMigrations(db);
const sql = sqlFromDatabase(db);

const app = createApp({
  auth,
  data: (principal) => createScopedData(sql, principal),
  allowedHosts: config.allowedHosts,
  staticHandler: serveStatic({ root: './app/public' }),
});

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`SpoolSpot (dev) listening on http://${info.address}:${String(info.port)}`);
  if (applied.length > 0) console.log(`applied migrations: ${applied.join(', ')}`);
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
