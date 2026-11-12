// SPDX-License-Identifier: AGPL-3.0-or-later
// SPOOL-199: the adapter's statement allow-list. A prefix and shape check, not a SQL parser; the last
// group of tests records what it deliberately does not catch.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { memoryDatabase } from '../testing.ts';
import { assertData, assertRead, StatementNotAllowedError } from './statement-guard.ts';

const refusedRead = (q: string) => () => {
  assertRead(q);
};
const refusedData = (q: string) => () => {
  assertData(q);
};

describe('all() runs reads only', () => {
  it('allows SELECT and WITH ... SELECT, in any letter case, after comments and whitespace', () => {
    for (const q of [
      'SELECT 1',
      'select 1',
      '  \n\tSELECT 1',
      '-- why\nSELECT 1',
      '/* why */ SELECT 1',
      'WITH x AS (SELECT 1 AS n) SELECT n FROM x',
      'WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM x WHERE n < 3) SELECT n FROM x',
      "SELECT replace(name, 'a', 'b') FROM location",
      "SELECT 'PRAGMA; DROP TABLE x' AS text",
      'SELECT "update" FROM t',
      "WITH x AS (SELECT 'delete' AS w) SELECT w FROM x",
      'SELECT 1 -- ; trailing comment',
    ]) {
      expect(refusedRead(q), q).not.toThrow();
    }
  });

  it('refuses writes, pragmas and schema statements', () => {
    for (const q of [
      "INSERT INTO tenant_settings (tenant_id) VALUES ('t')",
      'UPDATE location SET capacity = 1',
      'DELETE FROM location',
      'PRAGMA foreign_keys',
      'PRAGMA foreign_keys = OFF',
      'CREATE TABLE x (a)',
      'VALUES (1)',
      'EXPLAIN SELECT 1',
    ]) {
      expect(refusedRead(q), q).toThrow(StatementNotAllowedError);
    }
  });

  it('refuses a WITH whose main statement writes', () => {
    for (const q of [
      'WITH x AS (SELECT 1 AS n) INSERT INTO t SELECT n FROM x',
      'WITH x AS (SELECT 1 AS n) UPDATE t SET a = 1',
      'with x as (select 1) delete from t',
    ]) {
      expect(refusedRead(q), q).toThrow(/a write in a read/);
    }
  });
});

describe('batch() runs data statements only', () => {
  it('allows INSERT, UPDATE, DELETE, SELECT and WITH, including upserts and INSERT OR IGNORE', () => {
    for (const q of [
      "INSERT INTO tenant_settings (tenant_id) VALUES ('t') ON CONFLICT (tenant_id) DO NOTHING",
      'INSERT INTO s (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET b = b + 1 WHERE b < 5',
      'INSERT OR IGNORE INTO s (a) VALUES (1)',
      'UPDATE location SET capacity = 1 WHERE tenant_id = ?',
      'DELETE FROM clip WHERE tenant_id = ?',
      'SELECT 1',
      'WITH x AS (SELECT 1 AS n) INSERT INTO t SELECT n FROM x',
      '/* leading */ -- comments\n  insert into t values (1)',
    ]) {
      expect(refusedData(q), q).not.toThrow();
    }
  });

  it('refuses pragmas, attach, schema changes, maintenance and transaction control', () => {
    for (const q of [
      'PRAGMA defer_foreign_keys = OFF',
      "ATTACH DATABASE ':memory:' AS other",
      'DETACH DATABASE other',
      'CREATE TABLE x (a)',
      'CREATE TEMP TRIGGER t AFTER INSERT ON event BEGIN SELECT 1; END',
      'DROP TABLE x',
      'ALTER TABLE x RENAME TO y',
      'VACUUM',
      'REINDEX',
      'ANALYZE',
      'BEGIN',
      'COMMIT',
      'END',
      'ROLLBACK',
      'SAVEPOINT s',
      'RELEASE s',
      'EXPLAIN DELETE FROM x',
      'VALUES (1)',
      '',
      '   ',
    ]) {
      expect(refusedData(q), q).toThrow(StatementNotAllowedError);
    }
  });

  // Tables other than the ones tag-registry.test.ts scans the repository for: the adapter refuses
  // REPLACE everywhere, and that scan keeps covering paths that do not use the adapter.
  it('refuses REPLACE on every table: it removes rows without firing delete triggers', () => {
    for (const q of [
      'REPLACE INTO tenant_settings (tenant_id) VALUES (?)',
      'INSERT OR REPLACE INTO filament (id) VALUES (?)',
      'insert  or\nreplace into stock_line (id) values (?)',
      'UPDATE OR REPLACE tag SET tag_id = ?',
      'WITH x AS (SELECT 1) REPLACE INTO t SELECT * FROM x',
    ]) {
      expect(refusedData(q), q).toThrow(/a REPLACE write/);
    }
  });

  it('refuses a comment that hides a forbidden statement behind an allowed word', () => {
    for (const q of ['/* SELECT */ PRAGMA foreign_keys = OFF', '-- SELECT\nDROP TABLE x']) {
      expect(refusedData(q), q).toThrow(StatementNotAllowedError);
      expect(refusedRead(q), q).toThrow(StatementNotAllowedError);
    }
  });
});

describe('one statement per call', () => {
  it('refuses a second statement, and a trailing semicolon', () => {
    for (const q of [
      'SELECT 1; PRAGMA foreign_keys = OFF',
      "INSERT INTO t VALUES ('a'); DROP TABLE t",
      'SELECT 1;',
      'SELECT 1 /* x */ ; -- y',
    ]) {
      expect(refusedData(q), q).toThrow(/more than one statement/);
      expect(refusedRead(q), q).toThrow(/more than one statement/);
    }
  });

  it('refuses an unclosed quote or comment instead of guessing where it ends', () => {
    for (const q of ["SELECT 'abc", 'SELECT "abc', 'SELECT [abc', 'SELECT `abc', 'SELECT 1 /* x']) {
      expect(refusedRead(q), q).toThrow(StatementNotAllowedError);
    }
    expect(refusedRead("SELECT 'it''s'")).not.toThrow();
    expect(refusedRead('SELECT "a""b" FROM t')).not.toThrow();
  });

  it('names the statement class in the error, never the SQL text', () => {
    try {
      assertData("PRAGMA secret_looking_value = 'abc'");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StatementNotAllowedError);
      expect((error as Error).name).toBe('StatementNotAllowedError');
      expect((error as Error).message).not.toMatch(/secret_looking_value|abc/);
    }
  });
});

describe('what the allow-list does not catch (it is not a SQL parser)', () => {
  it('an allowed statement that fires a trigger passes the check; the trigger runs', async () => {
    const { db, sql } = memoryDatabase();
    db.prepare("INSERT INTO tenant_settings (tenant_id) VALUES ('t')").run();
    db.prepare(
      `INSERT INTO location (tenant_id, id, name, type, leaf, capacity_mode, tag_source)
       VALUES ('t', 'shelf', 'Shelf', 'active_storage', 1, 'hard', 'sticker')`,
    ).run();
    // Setting a place's tag is an ordinary UPDATE; the registry trigger (migration 0002) writes the
    // tag table too. The check sees only the UPDATE.
    expect(
      refusedData("UPDATE location SET tag_id = 'ABCDEFGHJKMN' WHERE id = 'shelf'"),
    ).not.toThrow();
    await sql.batch([
      {
        query: "UPDATE location SET tag_id = 'ABCDEFGHJKMN' WHERE tenant_id = 't' AND id = 'shelf'",
      },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM tag WHERE tenant_id = 't'").get()).toMatchObject({
      n: 1,
    });
  });

  it('an allowed statement can still do harm: it does not check tenant filters or table names', () => {
    expect(refusedData('DELETE FROM location')).not.toThrow();
    expect(refusedData('UPDATE tenant_settings SET moderate_threshold = 0')).not.toThrow();
    expect(refusedRead('SELECT * FROM clip')).not.toThrow();
  });

  it('a WITH read is judged by its words: a bare keyword-named identifier would be refused', () => {
    // SQLite needs such an identifier quoted, and quoted text is ignored, so in practice this only
    // over-refuses; it never lets a write through.
    expect(refusedRead('WITH x AS (SELECT 1 AS n) SELECT n FROM x')).not.toThrow();
    expect(refusedRead('WITH x AS (SELECT 1 AS "delete") SELECT "delete" FROM x')).not.toThrow();
  });
});

describe('raw database paths outside the adapter (SPOOL-199)', () => {
  // Application code reaches the database only through the Sql adapter. The files below hold the
  // database handle on purpose: the adapter and the startup checks (db/), the migration runner, the
  // entry points that open the database, demo data (its own transaction, which runs the closing check
  // itself), the a11y fixture and the test helpers. A new file here needs review.
  it('only the known files open the database or use its handle', () => {
    const allowed = [
      'app/src/db/integrity.ts',
      'app/src/db/migrate.ts',
      'app/src/db/sqlite.ts',
      'app/src/seed/demo.ts',
      'app/src/server.ts',
      'app/src/testing.ts',
      'app/src/testing-fail-commit.ts',
      'scripts/a11y-check.ts',
      'scripts/catalog-import.ts',
      'scripts/demo-data.ts',
      'scripts/demo-links.ts',
      'scripts/import-seed.ts',
      'scripts/migrate.ts',
    ];
    const raw =
      /from ['"]node:sqlite['"]|\bDatabaseSync\b|\bopenDatabase\(|\.prepare\(|\bdb\.exec\(/;
    const tracked = execFileSync('git', ['ls-files', '-z', 'app/src', 'scripts'], {
      encoding: 'utf8',
    })
      .split('\0')
      .filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts'));
    expect(tracked.length).toBeGreaterThan(20);
    const users = tracked.filter((f) => raw.test(readFileSync(f, 'utf8')));
    expect(users.sort()).toEqual(allowed.sort());
  });

  it('route handlers and the data layer never import the database driver or the opener', () => {
    const tracked = execFileSync('git', ['ls-files', '-z', 'app/src/http', 'app/src/data'], {
      encoding: 'utf8',
    })
      .split('\0')
      .filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts'));
    expect(tracked.length).toBeGreaterThan(5);
    for (const f of tracked) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(
        /from ['"][^'"]*(node:sqlite|db\/sqlite\.ts|db\/migrate\.ts)['"]/,
      );
    }
  });
});
