// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared helpers for tests only. Never imported by application code.
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_DIR, runMigrations } from './db/migrate.ts';
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

/** Applies only the migrations up to and including `last` (a migration file name) to `db`. */
export function migrateUpTo(db: DatabaseSync, last: string): void {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f <= last);
  if (!files.includes(last)) throw new Error(`no migration named ${last}`);
  const dir = mkdtempSync(join(tmpdir(), 'spoolspot-mig-'));
  try {
    for (const f of files) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
    runMigrations(db, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * An in-memory database migrated only up to and including `last` (a migration file name), so a test can
 * write rows the way an older database held them and then call runMigrations(db) for the rest.
 */
export function memoryDatabaseUpTo(last: string): { db: DatabaseSync; sql: Sql } {
  const db = openDatabase(':memory:');
  migrateUpTo(db, last);
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
