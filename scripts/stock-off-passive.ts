// SPDX-License-Identifier: AGPL-3.0-or-later
// Usage: node scripts/stock-off-passive.ts
// Lists boxed stock lines that are not at passive storage (SPOOL-200), per tenant, in the database named
// by SPOOLSPOT_DB (default data/spoolspot.db). Read only: it opens the file read only (no pragma, no
// chmod, no -wal or -shm file on a cleanly closed database) and does not migrate or change anything.
// Run it as the same user as the server: if a -wal file exists without its -shm file (after a crash),
// SQLite creates the -shm, owned by whoever runs this. With no -wal file the database is read as
// immutable (no locking, no change detection): run it with the server stopped, or run it again if the
// result looks wrong; the worst case is a stale or failed listing, never a write. Such
// lines come from a database written before migration 0004. The API counts them down to zero
// (POST /api/v1/stock/adjust with delta -1), never up; the stock page offers passive places only.
// The output names places and filaments: keep it to yourself.
import { existsSync } from 'node:fs';
import { loadConfig } from '../app/src/config.ts';
import { openDatabaseReadOnly } from '../app/src/db/sqlite.ts';
import { stockOffPassive } from '../app/src/db/stock-off-passive.ts';

const config = loadConfig(process.env);
if (!existsSync(config.databasePath)) {
  console.error(`No database at ${config.databasePath}. Set SPOOLSPOT_DB to its path.`);
  process.exit(2);
}
const db = openDatabaseReadOnly(config.databasePath);
try {
  const rows = stockOffPassive(db);
  if (rows.length === 0) {
    console.log('Every boxed stock line is at passive storage.');
  } else {
    let tenant = '';
    for (const r of rows) {
      if (r.tenant_id !== tenant) {
        tenant = r.tenant_id;
        console.log(`tenant ${tenant}:`);
      }
      console.log(
        `  ${r.location_id} (${r.location_type}): ${r.filament}, ${r.pack}, count ${String(r.count)}`,
      );
    }
    console.log(
      `${String(rows.length)} line(s) are not at passive storage. Their counts can go down to zero, never up; new boxed stock goes on passive storage.`,
    );
  }
} finally {
  db.close();
}
