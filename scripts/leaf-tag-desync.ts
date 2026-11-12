// SPDX-License-Identifier: AGPL-3.0-or-later
// Usage: node scripts/leaf-tag-desync.ts
// Lists leaves whose tag is in the tag registry but not in their own tag column (SPOOL-198), per
// tenant, in the database named by SPOOLSPOT_DB (default data/spoolspot.db). Such a place was a
// container changed into a leaf before migration 0005. Its tag still resolves to it; nothing is lost.
// Read only, with the same open as scripts/stock-off-passive.ts (see its notes on -wal and -shm files):
// it does not migrate or change anything. To bring a listed place in step, claim its listed tag again
// for it (POST /api/v1/tags/<tag>/claim); claiming another tag for it needs replace.
// The output names places and tag IDs: keep it to yourself.
import { existsSync } from 'node:fs';
import { loadConfig } from '../app/src/config.ts';
import { leafTagDesync } from '../app/src/db/leaf-tag-desync.ts';
import { openDatabaseReadOnly } from '../app/src/db/sqlite.ts';

const config = loadConfig(process.env);
if (!existsSync(config.databasePath)) {
  console.error(`No database at ${config.databasePath}. Set SPOOLSPOT_DB to its path.`);
  process.exit(2);
}
const db = openDatabaseReadOnly(config.databasePath);
try {
  const rows = leafTagDesync(db);
  if (rows.length === 0) {
    console.log("Every leaf's tag is in its own tag column.");
  } else {
    let tenant = '';
    for (const r of rows) {
      if (r.tenant_id !== tenant) {
        tenant = r.tenant_id;
        console.log(`tenant ${tenant}:`);
      }
      console.log(
        `  ${r.location_id}: registry tag ${r.registry_tag}, column ${r.column_tag ?? 'empty'}`,
      );
    }
    console.log(
      `${String(rows.length)} leaf place(s) have a registry tag their column does not show. Claim the listed tag again for the place to set the column.`,
    );
  }
} finally {
  db.close();
}
