// SPDX-License-Identifier: AGPL-3.0-or-later
// Node adapter: node:sqlite behind the Sql interface (ADR-0003 prefers it over a native module).
// node:sqlite is still marked experimental on Node 22 and a release candidate on Node 24; this file is
// the only place that touches it, so a swap to better-sqlite3 is a one-file change (recorded on SPOOL-131).
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GRANT_CLOSED_CHECK, GrantCloseCheckError, hasGrantCloser } from './integrity.ts';
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

/** The connection was dropped after a rollback failed inside a transaction. Restart to recover. */
export class DatabaseUnusableError extends Error {
  constructor() {
    super('database connection is unusable after a failed rollback');
    this.name = 'DatabaseUnusableError';
  }
}

/**
 * Whether the connection is inside a transaction. `isTransaction` exists on every Node version the
 * project supports (engines >= 22.18); the fallback probe is for anything older: BEGIN fails only when
 * a transaction is already open, and a BEGIN that succeeds is undone at once.
 */
function inTransaction(db: DatabaseSync): boolean {
  const flag: unknown = (db as { isTransaction?: unknown }).isTransaction;
  if (typeof flag === 'boolean') return flag;
  try {
    db.exec('BEGIN');
  } catch {
    return true;
  }
  db.exec('ROLLBACK');
  return false;
}

export function sqlFromDatabase(db: DatabaseSync): Sql {
  // Set when a rollback fails: the connection may still be inside a half-done transaction (with an
  // event delete grant visible to it), so it is closed and never used again. Restart to recover.
  let unusable = false;
  // Once the closer has been seen on this connection it is always run: if it is later dropped or
  // renamed, the appended statement fails ("no such table") and the batch rolls back, instead of the
  // check being skipped as it is on a database from before migration 0003. Seen at creation too, so a
  // first batch that removes it cannot skip it either.
  let closerSeen = hasGrantCloser(db);
  const usable = (): void => {
    if (unusable) throw new DatabaseUnusableError();
  };
  return {
    all<T extends object>(query: string, params?: readonly SqlParam[]): Promise<T[]> {
      return attempt(() => {
        usable();
        return db.prepare(query).all(...bind(params)) as T[];
      });
    },
    batch(statements: readonly Statement[]): Promise<number[]> {
      return attempt(() => {
        usable();
        db.exec('BEGIN IMMEDIATE');
        try {
          const changes: number[] = [];
          for (const s of statements) {
            changes.push(Number(db.prepare(s.query).run(...bind(s.params)).changes));
          }
          // Last statement of every batch (SPOOL-194): an event delete grant still open aborts the
          // batch. Here, not in callers, so no batch can forget it. Skipped before migration 0003.
          if (closerSeen || hasGrantCloser(db)) {
            closerSeen = true;
            try {
              db.prepare(GRANT_CLOSED_CHECK.query).run();
            } catch (cause) {
              throw new GrantCloseCheckError(cause);
            }
          }
          db.exec('COMMIT');
          return changes;
        } catch (error) {
          try {
            db.exec('ROLLBACK');
          } catch {
            // Keep the original error (the rollback failure would hide the cause). If the connection
            // is still inside the transaction, drop it: closing discards the transaction. A rollback
            // that failed because no transaction was left (SQLite ended it already) changes nothing.
            if (inTransaction(db)) {
              unusable = true;
              try {
                db.close();
              } catch {
                /* already unusable */
              }
            }
          }
          throw error;
        }
      });
    },
  };
}
