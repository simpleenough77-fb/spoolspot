// SPDX-License-Identifier: AGPL-3.0-or-later
// Usage: node scripts/demo-data.ts fill | remove
// Adds (or removes) clearly marked demo items so the location tree shows used and free places on your
// own tree. Uses the database named by SPOOLSPOT_DB (default data/spoolspot.db), self-host tenant only.
import { loadConfig } from '../app/src/config.ts';
import { runMigrations } from '../app/src/db/migrate.ts';
import { openDatabase } from '../app/src/db/sqlite.ts';
import { fillDemo, removeDemo } from '../app/src/seed/demo.ts';

const action = process.argv[2];
if (action !== 'fill' && action !== 'remove') {
  console.error('Usage: node scripts/demo-data.ts fill | remove');
  process.exit(2);
}
const config = loadConfig(process.env);
const db = openDatabase(config.databasePath);
try {
  runMigrations(db);
  if (action === 'fill') {
    const r = fillDemo(db, config.tenantId);
    console.log(
      r.alreadyThere
        ? 'Demo items are already there. Run "remove" first to start over.'
        : `Added ${String(r.clips)} demo clips and ${String(r.stockSpools)} boxed demo spools.`,
    );
  } else {
    console.log(`Removed ${String(removeDemo(db, config.tenantId))} demo clips and their stock.`);
  }
} finally {
  db.close();
}
