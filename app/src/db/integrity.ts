// SPDX-License-Identifier: AGPL-3.0-or-later
// Database invariants the application relies on (SPOOL-194, migration 0003), checked when a database
// is opened for use and enforced at the end of every write batch. Node only for now; a D1 adapter must
// append the same closing check to its batches.
import type { DatabaseSync } from 'node:sqlite';
import type { Statement } from './sql.ts';

/**
 * The closing check: the last statement of every batch that may carry an event delete grant. When a
 * grant row is still there, it inserts into event_delete_grant_closed, whose trigger always aborts, so
 * the batch rolls back. It does not depend on any pragma. Every name here is qualified with `main.`:
 * a temporary table of the same name would otherwise stand in for the real one.
 */
export const GRANT_CLOSED_CHECK: Statement = {
  query:
    'INSERT INTO main.event_delete_grant_closed (tenant_id, x) SELECT tenant_id, 1 FROM main.event_delete_grant LIMIT 1',
};

/** Whether migration 0003 is in this database, so batches before it still work. */
export function hasGrantCloser(db: DatabaseSync): boolean {
  return (
    db
      .prepare("SELECT 1 AS n FROM main.sqlite_master WHERE type = 'table' AND name = ?")
      .get('event_delete_grant_closed') !== undefined
  );
}

/**
 * The closing check stopped a batch: a grant was left open, or the closer itself is missing. The batch
 * was rolled back. Named so the one-line request log identifies it; HTTP answers stay generic.
 */
export class GrantCloseCheckError extends Error {
  constructor(cause: unknown) {
    super(
      `closing check failed, batch rolled back (${cause instanceof Error ? cause.message : 'unknown'})`,
      {
        cause,
      },
    );
    this.name = 'GrantCloseCheckError';
  }
}

export class DatabaseIntegrityError extends Error {
  constructor(problem: string) {
    super(`refusing to use this database: ${problem}`);
    this.name = 'DatabaseIntegrityError';
  }
}

function exists(db: DatabaseSync, type: 'table' | 'trigger', name: string): boolean {
  return (
    db
      .prepare('SELECT 1 AS n FROM main.sqlite_master WHERE type = ? AND name = ?')
      .get(type, name) !== undefined
  );
}

/**
 * Throws DatabaseIntegrityError when the database is not safe to serve: foreign keys off, an event log
 * trigger missing, or an event delete grant left behind (a grant may only exist inside the batch that
 * opened it). Run after migrations, before anything else uses the database.
 */
export function verifyDatabase(db: DatabaseSync): void {
  const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number } | undefined;
  if (fk?.foreign_keys !== 1) throw new DatabaseIntegrityError('foreign keys are not enforced');
  // The triggers that keep the event log append-only. A store that does not apply a migration file in
  // one transaction could be left with a table and without its triggers; refuse that.
  const required = exists(db, 'table', 'event')
    ? ['event_is_append_only_update', 'event_is_append_only_delete']
    : [];
  if (exists(db, 'table', 'event_delete_grant')) {
    required.push(
      'event_insert_is_new',
      'event_delete_grant_left_open',
      'event_delete_grant_is_not_updated',
    );
  }
  for (const trigger of required) {
    if (!exists(db, 'trigger', trigger)) {
      throw new DatabaseIntegrityError(`the event log trigger ${trigger} is missing`);
    }
  }
  if (exists(db, 'table', 'event_delete_grant')) {
    const open = db.prepare('SELECT COUNT(*) AS n FROM main.event_delete_grant').get() as {
      n: number;
    };
    if (open.n > 0) {
      throw new DatabaseIntegrityError(
        'an event delete grant was left open; remove the row from event_delete_grant after checking which events are missing',
      );
    }
  }
}
