// SPDX-License-Identifier: AGPL-3.0-or-later
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { memoryDatabase } from '../testing.ts';
import { MIGRATIONS_DIR, runMigrations } from './migrate.ts';
import { GrantCloseCheckError } from './integrity.ts';
import { DatabaseUnusableError, describeCause, openDatabase, sqlFromDatabase } from './sqlite.ts';
import { StatementNotAllowedError } from './statement-guard.ts';

describe('sql adapter', () => {
  it('refuses a statement that binds more than 100 parameters (D1 limit)', async () => {
    const { sql } = memoryDatabase();
    const many = Array.from({ length: 101 }, () => 1);
    await expect(sql.all('SELECT 1', many)).rejects.toThrow(/at most 100/);
    await expect(sql.batch([{ query: 'SELECT 1', params: many }])).rejects.toThrow(/at most 100/);
  });

  it('allows exactly 100 parameters', async () => {
    const { sql } = memoryDatabase();
    const hundred = Array.from({ length: 100 }, () => 1);
    const placeholders = hundred.map(() => '?').join(',');
    await expect(sql.all(`SELECT ${placeholders}`, hundred)).resolves.toHaveLength(1);
  });

  it('keeps the original error when a batch fails', async () => {
    const { sql } = memoryDatabase();
    await expect(sql.batch([{ query: 'INSERT INTO nope VALUES (1)' }])).rejects.toThrow(/nope/);
  });

  it('makes the connection unusable when a rollback fails, so a half-done batch is never kept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spoolspot-rollback-'));
    try {
      const path = join(dir, 'test.db');
      const real = openDatabase(path);
      runMigrations(real);
      // The same connection, except that ROLLBACK fails (as it can on an I/O error).
      const broken = new Proxy(real, {
        get(target, key) {
          if (key === 'exec') {
            return (text: string) => {
              if (text === 'ROLLBACK') throw new Error('disk I/O error');
              target.exec(text);
            };
          }
          const value: unknown = Reflect.get(target, key);
          return typeof value === 'function'
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      });
      let unusableCalls = 0;
      let cause: unknown;
      const sql = sqlFromDatabase(broken, {
        onUnusable: (error) => {
          unusableCalls += 1;
          cause = error;
        },
      });
      await expect(
        sql.batch([
          { query: "INSERT INTO tenant_settings (tenant_id) VALUES ('half-done')" },
          { query: 'INSERT INTO nope VALUES (1)' },
        ]),
      ).rejects.toThrow(/nope/);
      await expect(sql.all('SELECT 1 AS n')).rejects.toBeInstanceOf(DatabaseUnusableError);
      await expect(sql.batch([{ query: 'SELECT 1' }])).rejects.toThrow(/unusable/);
      expect(real.isOpen).toBe(false);
      // Told once, when the connection was dropped (the server exits there, SPOOL-199).
      expect(unusableCalls).toBe(1);
      // With the error that started it (the failed INSERT), not the rollback failure.
      expect(describeCause(cause)).toBe('cause Error, code ERR_SQLITE_ERROR, errcode 1');
      const again = openDatabase(path);
      expect(again.prepare('SELECT COUNT(*) AS n FROM tenant_settings').get()).toMatchObject({
        n: 0,
      });
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs batches on a database from before migration 0003, which has no grant closer yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spoolspot-pre0003-'));
    try {
      for (const f of ['0001_init.sql', '0002_tag_registry.sql']) {
        copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
      }
      const db = openDatabase(':memory:');
      expect(runMigrations(db, dir)).toEqual(['0001_init.sql', '0002_tag_registry.sql']);
      const sql = sqlFromDatabase(db);
      await expect(
        sql.batch([{ query: "INSERT INTO tenant_settings (tenant_id) VALUES ('old')" }]),
      ).resolves.toEqual([1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the connection when ROLLBACK fails only because no transaction is left', async () => {
    const real = openDatabase(':memory:');
    runMigrations(real);
    // The rollback happens, then reports an error (as when SQLite already ended the transaction).
    const flaky = new Proxy(real, {
      get(target, key) {
        if (key === 'exec') {
          return (text: string) => {
            target.exec(text);
            if (text === 'ROLLBACK') throw new Error('cannot rollback - no transaction is active');
          };
        }
        const value: unknown = Reflect.get(target, key);
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    let unusableCalls = 0;
    const sql = sqlFromDatabase(flaky, { onUnusable: () => (unusableCalls += 1) });
    await expect(sql.batch([{ query: 'INSERT INTO nope VALUES (1)' }])).rejects.toThrow(/nope/);
    expect(real.isOpen).toBe(true);
    expect(unusableCalls).toBe(0);
    await expect(sql.all('SELECT 1 AS n')).resolves.toEqual([{ n: 1 }]);
    real.close();
  });

  it('names a closing-check failure so the request log can tell it apart', async () => {
    const { sql } = memoryDatabase();
    const failure = sql.batch([
      { query: "INSERT INTO tenant_settings (tenant_id) VALUES ('t')" },
      { query: "INSERT INTO event_delete_grant (tenant_id, scope) VALUES ('t', 'tenant')" },
    ]);
    await expect(failure).rejects.toBeInstanceOf(GrantCloseCheckError);
    await expect(failure).rejects.toMatchObject({ name: 'GrantCloseCheckError' });
  });

  it("appends the closing check after the caller's last statement and adds no result for it", async () => {
    const { sql, db } = memoryDatabase();
    db.prepare("INSERT INTO tenant_settings (tenant_id) VALUES ('a'), ('b')").run();
    // A statement that reads changes() must see the caller's previous write, not the closing check.
    const guard = {
      query:
        'INSERT INTO tag (tenant_id, tag_id, kind, target_id) SELECT NULL, NULL, NULL, NULL WHERE changes() > 1',
    };
    await expect(
      sql.batch([{ query: 'UPDATE tenant_settings SET moderate_threshold = 2' }, guard]),
    ).rejects.toThrow(/NOT NULL/);
    expect(
      await sql.batch([
        { query: "UPDATE tenant_settings SET moderate_threshold = 2 WHERE tenant_id = 'a'" },
        guard,
      ]),
    ).toEqual([1, 0]);
  });

  it('checks every statement of a batch before it starts: a refused batch runs nothing (SPOOL-199)', async () => {
    const { sql, db } = memoryDatabase();
    const ran: string[] = [];
    const watched = new Proxy(db, {
      get(target, key) {
        if (key === 'exec' || key === 'prepare') {
          return (text: string) => {
            ran.push(text);
            if (key === 'exec') {
              target.exec(text);
              return undefined;
            }
            return target.prepare(text);
          };
        }
        const value: unknown = Reflect.get(target, key);
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const guarded = sqlFromDatabase(watched);
    ran.length = 0;
    await expect(
      guarded.batch([
        { query: "INSERT INTO tenant_settings (tenant_id) VALUES ('first')" },
        { query: 'PRAGMA foreign_keys = OFF' },
      ]),
    ).rejects.toBeInstanceOf(StatementNotAllowedError);
    await expect(guarded.all('PRAGMA foreign_keys = OFF')).rejects.toBeInstanceOf(
      StatementNotAllowedError,
    );
    // Nothing reached the connection: no BEGIN, no INSERT, no pragma.
    expect(ran).toEqual([]);
    expect(db.isTransaction).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tenant_settings').get()).toMatchObject({ n: 0 });
    // The connection stays usable for allowed statements.
    await expect(
      sql.batch([{ query: "INSERT INTO tenant_settings (tenant_id) VALUES ('ok')" }]),
    ).resolves.toEqual([1]);
    await expect(sql.all('SELECT tenant_id FROM tenant_settings')).resolves.toEqual([
      { tenant_id: 'ok' },
    ]);
  });

  it('runs every statement the application sends: reads through all(), writes through batch()', async () => {
    // The shapes in use today (SPOOL-199 inventory): upserts, INSERT ... SELECT with a guard,
    // UPDATE and DELETE keyed to a tenant, and the changes() guard of the tag claim.
    const { sql } = memoryDatabase();
    expect(
      await sql.batch([
        {
          query:
            "INSERT INTO tenant_settings (tenant_id) VALUES ('t') ON CONFLICT (tenant_id) DO NOTHING",
        },
        { query: "UPDATE tenant_settings SET moderate_threshold = 2 WHERE tenant_id = 't'" },
        {
          query:
            'INSERT INTO tag (tenant_id, tag_id, kind, target_id) SELECT NULL, NULL, NULL, NULL WHERE changes() > 1',
        },
        { query: "DELETE FROM stock_line WHERE tenant_id = 't'" },
      ]),
    ).toEqual([1, 1, 0, 0]);
    await expect(
      sql.all('WITH s AS (SELECT tenant_id FROM tenant_settings) SELECT COUNT(*) AS n FROM s'),
    ).resolves.toEqual([{ n: 1 }]);
  });

  it('describes a cause by class and SQLite codes only, never its message', () => {
    const sqliteError = Object.assign(
      new Error("UNIQUE constraint failed: tag.tag_id 'ABCDEFGHJKMN' INSERT INTO tag"),
      { code: 'ERR_SQLITE_ERROR', errcode: 2067 },
    );
    const line = describeCause(sqliteError);
    expect(line).toBe('cause Error, code ERR_SQLITE_ERROR, errcode 2067');
    expect(line).not.toMatch(/UNIQUE|ABCDEFGHJKMN|INSERT|tag/);
    class OddError extends Error {
      override name = 'Odd name; DROP TABLE x';
    }
    expect(
      describeCause(Object.assign(new OddError('x'), { code: 'not safe; x', errcode: 1.5 })),
    ).toBe('cause Error');
    expect(describeCause('a string with SELECT 1')).toBe('cause unknown');
  });
});
