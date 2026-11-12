// SPDX-License-Identifier: AGPL-3.0-or-later
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { memoryDatabase } from '../testing.ts';
import { MIGRATIONS_DIR, runMigrations } from './migrate.ts';
import { GrantCloseCheckError } from './integrity.ts';
import { DatabaseUnusableError, openDatabase, sqlFromDatabase } from './sqlite.ts';

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
      const sql = sqlFromDatabase(broken);
      await expect(
        sql.batch([
          { query: "INSERT INTO tenant_settings (tenant_id) VALUES ('half-done')" },
          { query: 'INSERT INTO nope VALUES (1)' },
        ]),
      ).rejects.toThrow(/nope/);
      await expect(sql.all('SELECT 1 AS n')).rejects.toBeInstanceOf(DatabaseUnusableError);
      await expect(sql.batch([{ query: 'SELECT 1' }])).rejects.toThrow(/unusable/);
      expect(real.isOpen).toBe(false);
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
    const sql = sqlFromDatabase(flaky);
    await expect(sql.batch([{ query: 'INSERT INTO nope VALUES (1)' }])).rejects.toThrow(/nope/);
    expect(real.isOpen).toBe(true);
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
});
