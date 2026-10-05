// SPDX-License-Identifier: AGPL-3.0-or-later
// Usage: node scripts/catalog-import.ts [catalog.json]   (default seed/catalog-sample.json)
// Imports a filament catalog into the self-host tenant of the database named by SPOOLSPOT_DB.
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CatalogInvalidError, importCatalog } from '../app/src/catalog/import.ts';
import { loadConfig } from '../app/src/config.ts';
import { runMigrations } from '../app/src/db/migrate.ts';
import { openDatabase, sqlFromDatabase } from '../app/src/db/sqlite.ts';

const MAX_BYTES = 2_000_000;
const root = (p: string): string => fileURLToPath(new URL(`../${p}`, import.meta.url));
const path = process.argv[2] ?? root('seed/catalog-sample.json');

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

/** Reads one regular file of bounded size, checked on the open descriptor (no check-then-read gap). */
function readBounded(file: string): string {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return fail(`Cannot open ${file}.`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return fail(`${file} is not a regular file.`);
    if (stat.size > MAX_BYTES)
      return fail(`${file} is larger than ${String(MAX_BYTES)} bytes; refusing to read it.`);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

let doc: unknown;
try {
  doc = JSON.parse(readBounded(path));
} catch (error) {
  if (error instanceof SyntaxError) fail(`${path} is not valid JSON: ${error.message}`);
  throw error;
}
const schema = JSON.parse(readFileSync(root('schema/catalog.schema.json'), 'utf8')) as object;
const config = loadConfig(process.env);
const db = openDatabase(config.databasePath);
try {
  runMigrations(db);
  const r = await importCatalog(sqlFromDatabase(db), config.tenantId, doc, schema);
  console.log(
    `Imported ${String(r.inserted)} filaments, skipped ${String(r.skipped)} already there` +
      (r.differing > 0
        ? ` (${String(r.differing)} differ from the catalog and were left unchanged: ${r.differing_ids.join(', ')}).`
        : '.'),
  );
} catch (error) {
  if (error instanceof CatalogInvalidError) {
    console.error(`${path} was not imported:`);
    for (const issue of error.issues) console.error(`  ${issue.path}: ${issue.message}`);
    process.exit(1);
  }
  throw error;
} finally {
  db.close();
}
