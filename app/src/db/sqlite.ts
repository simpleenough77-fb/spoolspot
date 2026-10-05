// SPDX-License-Identifier: AGPL-3.0-or-later
// Node adapter: node:sqlite behind the Sql interface (ADR-0003 prefers it over a native module).
// node:sqlite is still marked experimental on Node 22 and a release candidate on Node 24; this file is
// the only place that touches it, so a swap to better-sqlite3 is a one-file change (recorded on SPOOL-131).
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Sql, SqlParam, Statement } from './sql.ts';

function attempt<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Cloudflare D1 allows at most 100 bound parameters per statement; enforce it here so tests catch a breach. */
const MAX_BOUND_PARAMETERS = 100;

function bind(params: readonly SqlParam[] | undefined): SqlParam[] {
  if (params && params.length > MAX_BOUND_PARAMETERS) {
    throw new Error(
      `a statement may bind at most ${String(MAX_BOUND_PARAMETERS)} parameters (D1 limit)`,
    );
  }
  return params ? [...params] : [];
}

/**
 * Open (creating if needed) a SQLite database with foreign keys enforced. File databases live in a
 * directory only the owner can enter and are readable only by the owner: they hold tenant inventory
 * (Confidential, ADR-0007). Use ':memory:' for tests.
 */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  db.exec('PRAGMA busy_timeout = 5000');
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    chmodSync(path, 0o600);
  }
  return db;
}

export function sqlFromDatabase(db: DatabaseSync): Sql {
  return {
    all<T extends object>(query: string, params?: readonly SqlParam[]): Promise<T[]> {
      return attempt(() => db.prepare(query).all(...bind(params)) as T[]);
    },
    batch(statements: readonly Statement[]): Promise<number[]> {
      return attempt(() => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const changes: number[] = [];
          for (const s of statements) {
            changes.push(Number(db.prepare(s.query).run(...bind(s.params)).changes));
          }
          db.exec('COMMIT');
          return changes;
        } catch (error) {
          try {
            db.exec('ROLLBACK');
          } catch {
            /* keep the original error: the rollback failure would hide the cause */
          }
          throw error;
        }
      });
    },
  };
}
