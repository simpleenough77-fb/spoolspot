// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared helpers for tests only. Never imported by application code.
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './db/migrate.ts';
import { openDatabase, sqlFromDatabase } from './db/sqlite.ts';
import type { Sql } from './db/sql.ts';
import type { SeedDocument } from './seed/validate.ts';

export const TENANT_A = 'tenant-a';
export const TENANT_B = 'tenant-b';

export function memoryDatabase(): { db: DatabaseSync; sql: Sql } {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return { db, sql: sqlFromDatabase(db) };
}

export function readSeed(): SeedDocument {
  return JSON.parse(readFileSync('seed/locations-seed.json', 'utf8')) as SeedDocument;
}

export function readJson(path: string): object {
  return JSON.parse(readFileSync(path, 'utf8')) as object;
}

export const SEED_SCHEMA_PATH = 'schema/locations-seed.schema.json';

/** A valid dev token for tests. Not a secret. */
export const TEST_TOKEN = 'test-token-0123456789abcdef-0123456789abcdef';

let counter = 0;
/** A well-formed lower-case UUID, unique within a test run. */
export function uuid(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}
