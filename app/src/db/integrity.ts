// SPDX-License-Identifier: AGPL-3.0-or-later
// Database invariants the application relies on (SPOOL-194, migration 0003), checked when a database
// is opened for use and enforced at the end of every write batch. Node only for now; a D1 adapter must
// append the same closing check to its batches.
import type { DatabaseSync } from 'node:sqlite';
import type { Statement } from './sql.ts';

/**
 * The closing check: the last statement of every batch that may carry an event delete grant. When a
 * grant row is still there, it inserts into event_delete_grant_closed, whose trigger always aborts, so
 * the batch rolls back. It does not depend on any pragma.
 */
export const GRANT_CLOSED_CHECK: Statement = {
  query:
    'INSERT INTO event_delete_grant_closed (tenant_id, x) SELECT tenant_id, 1 FROM event_delete_grant LIMIT 1',
};

/** Whether migration 0003 is in this database, so batches before it still work. */
export function hasGrantCloser(db: DatabaseSync): boolean {
  return (
    db
      .prepare("SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get('event_delete_grant_closed') !== undefined
  );
}

export class DatabaseIntegrityError extends Error {
  constructor(problem: string) {
    super(`refusing to use this database: ${problem}`);
    this.name = 'DatabaseIntegrityError';
  }
}

function exists(db: DatabaseSync, type: 'table' | 'trigger', name: string): boolean {
  return (
    db.prepare('SELECT 1 AS n FROM sqlite_master WHERE type = ? AND name = ?').get(type, name) !==
    undefined
  );
}

/**
 * Throws DatabaseIntegrityError when the database is not safe to serve: foreign keys off, or an event
 * delete grant left behind (a grant may only exist inside the batch that opened it). Run after
 * migrations, before anything else uses the database.
 */
export function verifyDatabase(db: DatabaseSync): void {
  const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number } | undefined;
  if (fk?.foreign_keys !== 1) throw new DatabaseIntegrityError('foreign keys are not enforced');
  if (exists(db, 'table', 'event_delete_grant')) {
    if (!exists(db, 'trigger', 'event_delete_grant_left_open')) {
      throw new DatabaseIntegrityError('the event delete grant closer is missing');
    }
    const open = db.prepare('SELECT COUNT(*) AS n FROM event_delete_grant').get() as { n: number };
    if (open.n > 0) {
      throw new DatabaseIntegrityError(
        'an event delete grant was left open; remove the row from event_delete_grant after checking which events are missing',
      );
    }
  }
}
