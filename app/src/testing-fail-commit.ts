// SPDX-License-Identifier: AGPL-3.0-or-later
// Test only (server-start.test.ts). Loaded with `node --import` into a server process, it makes COMMIT
// and ROLLBACK fail on every connection, as a disk I/O error would, so the first write batch leaves the
// connection inside a transaction. Never imported by application code.
import { DatabaseSync } from 'node:sqlite';

// The original method, called with the connection as `this` below.
const original: (this: DatabaseSync, text: string) => void = Reflect.get(
  DatabaseSync.prototype,
  'exec',
);
Reflect.set(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, text: string): void {
  if (text === 'COMMIT' || text === 'ROLLBACK') {
    // Shaped like a node:sqlite error (SQLITE_IOERR = 10). The message carries a marker the test
    // checks never reaches the log.
    throw Object.assign(new Error('disk I/O error (simulated) MESSAGE-MARKER-7f3a'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 10,
    });
  }
  original.call(this, text);
});
