// SPDX-License-Identifier: AGPL-3.0-or-later
// SPOOL-194 review round 2: the server refuses to start on an unsafe database. server.ts is a script
// with no seam to import, so this runs it as a process.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './db/migrate.ts';
import { openDatabase } from './db/sqlite.ts';
import { TEST_TOKEN } from './testing.ts';

describe('server start', () => {
  it('exits with the reason, not a stack, when an event delete grant was left behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spoolspot-start-'));
    try {
      const path = join(dir, 'spoolspot.db');
      const db = openDatabase(path);
      runMigrations(db);
      db.exec('PRAGMA foreign_keys = OFF');
      db.prepare("INSERT INTO event_delete_grant (tenant_id, scope) VALUES ('t', 'tenant')").run();
      db.close();
      const run = spawnSync(process.execPath, ['app/src/server.ts'], {
        env: {
          ...process.env,
          SPOOLSPOT_DB: path,
          SPOOLSPOT_DEV_TOKEN: TEST_TOKEN,
          SPOOLSPOT_HOST: '127.0.0.1',
          SPOOLSPOT_PORT: String(20000 + Math.floor(Math.random() * 30000)),
        },
        encoding: 'utf8',
        // A server that started instead of refusing would still be running here.
        timeout: 15000,
      });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('refusing to use this database');
      expect(run.stderr).not.toMatch(/^\s+at /m);
      expect(run.stdout).not.toContain('listening');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});
