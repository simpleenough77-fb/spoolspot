// SPDX-License-Identifier: AGPL-3.0-or-later
// Usage: node scripts/import-seed.ts [seed.json]
// Imports the location seed into the self-host tenant of the database named by SPOOLSPOT_DB
// (default data/spoolspot.db). Safe to run again: existing locations are left alone.
import { readFileSync } from 'node:fs';
import { loadConfig } from '../app/src/config.ts';
import { runMigrations } from '../app/src/db/migrate.ts';
import { openDatabase, sqlFromDatabase } from '../app/src/db/sqlite.ts';
import { importSeed, SeedInvalidError } from '../app/src/seed/import.ts';

const seedPath = process.argv[2] ?? 'seed/locations-seed.json';
const config = loadConfig(process.env);
const seed: unknown = JSON.parse(readFileSync(seedPath, 'utf8'));
const schema = JSON.parse(readFileSync('schema/locations-seed.schema.json', 'utf8')) as object;

const db = openDatabase(config.databasePath);
try {
  runMigrations(db);
  const result = await importSeed(sqlFromDatabase(db), config.tenantId, seed, schema);
  console.log(
    `${seedPath}: ${String(result.inserted)} locations added, ${String(result.skipped)} already present.`,
  );
} catch (error) {
  if (error instanceof SeedInvalidError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  db.close();
}
