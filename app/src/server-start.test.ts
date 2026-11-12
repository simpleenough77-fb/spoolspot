// SPDX-License-Identifier: AGPL-3.0-or-later
// SPOOL-194 review round 2: the server refuses to start on an unsafe database. SPOOL-199: it exits when
// its connection becomes unusable. server.ts is a script with no seam to import, so this runs it as a
// process.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './db/migrate.ts';
import { openDatabase, sqlFromDatabase } from './db/sqlite.ts';
import { SELF_HOST_TENANT_ID } from './config.ts';
import { importSeed } from './seed/import.ts';
import { readJson, readSeed, SEED_SCHEMA_PATH, TEST_TOKEN, uuid } from './testing.ts';

const port = (): string => String(20000 + Math.floor(Math.random() * 30000));

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
          SPOOLSPOT_PORT: port(),
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

  it('exits with one line, no stack and no SQL, when a failed rollback leaves the connection unusable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spoolspot-unusable-'));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const path = join(dir, 'spoolspot.db');
      const db = openDatabase(path);
      runMigrations(db);
      await importSeed(
        sqlFromDatabase(db),
        SELF_HOST_TENANT_ID,
        readSeed(),
        readJson(SEED_SCHEMA_PATH),
      );
      const filament = uuid();
      db.prepare(
        "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, 'Acme', 'PLA', 'Red', 'refillable')",
      ).run(SELF_HOST_TENANT_ID, filament);
      db.close();
      // The preload makes COMMIT and ROLLBACK fail (testing-fail-commit.ts); the database file is fine.
      const proc = spawn(
        process.execPath,
        ['--import', './app/src/testing-fail-commit.ts', 'app/src/server.ts'],
        {
          env: {
            ...process.env,
            SPOOLSPOT_DB: path,
            SPOOLSPOT_DEV_TOKEN: TEST_TOKEN,
            SPOOLSPOT_HOST: '127.0.0.1',
            SPOOLSPOT_PORT: port(),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      child = proc;
      let stdout = '';
      let stderr = '';
      proc.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
      proc.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
      const exited = new Promise<number | null>((done) =>
        proc.on('exit', (code) => {
          done(code);
        }),
      );
      const deadline = Date.now() + 10000;
      while (!/listening on (http:\/\/\S+)/.test(stdout)) {
        if (Date.now() > deadline || proc.exitCode !== null) throw new Error(`no start: ${stderr}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      const base = /listening on (http:\/\/\S+)/.exec(stdout)?.[1] ?? '';
      // A write: its batch cannot commit, the rollback fails too, and the adapter closes the connection.
      await fetch(`${base}/api/v1/stock/adjust`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          filament_id: filament,
          location_id: 'closet-storage.shelf-1',
          pack: 'spool',
          delta: 1,
        }),
      }).catch(() => undefined);
      const code = await Promise.race([
        exited,
        new Promise<'timeout'>((r) =>
          setTimeout(() => {
            r('timeout');
          }, 10000),
        ),
      ]);
      expect(code).toBe(1);
      const lines = stderr
        .split('\n')
        .filter((l) => l.trim() !== '' && !/ExperimentalWarning|--trace-warnings/.test(l));
      expect(lines).toEqual([
        'database connection is unusable after a failed rollback; exiting so the server can be restarted',
      ]);
      expect(stderr).not.toMatch(/^\s+at /m);
      expect(stderr).not.toMatch(/INSERT|UPDATE|stock_line|disk I\/O/);
    } finally {
      if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
