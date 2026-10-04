// SPDX-License-Identifier: AGPL-3.0-or-later
// Usage: node scripts/migrate.ts
// Applies pending migrations to the database named by SPOOLSPOT_DB (default data/spoolspot.db).
import { loadConfig } from '../app/src/config.ts';
import { runMigrations } from '../app/src/db/migrate.ts';
import { openDatabase } from '../app/src/db/sqlite.ts';

const config = loadConfig(process.env);
const db = openDatabase(config.databasePath);
try {
  const applied = runMigrations(db);
  console.log(applied.length > 0 ? `applied: ${applied.join(', ')}` : 'database is up to date');
} finally {
  db.close();
}
