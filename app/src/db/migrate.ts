// SPDX-License-Identifier: AGPL-3.0-or-later
// Applies the committed SQL migrations in order. The SQL files are the source of truth (ADR-0003).
// Each file is recorded with its SHA-256; a file that changed after it was applied is an error, so a
// database never silently drifts from the repository. Node only (reads files); D1 uses its own tooling.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

export const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'migrations');

interface AppliedRow {
  name: string;
  sha256: string;
}

export function runMigrations(db: DatabaseSync, dir: string = MIGRATIONS_DIR): string[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT NOT NULL PRIMARY KEY,
       sha256 TEXT NOT NULL,
       applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ) STRICT`,
  );
  const applied = new Map(
    (db.prepare('SELECT name, sha256 FROM schema_migrations').all() as unknown as AppliedRow[]).map(
      (r) => [r.name, r.sha256],
    ),
  );

  const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  for (const f of files) {
    if (!NAME.test(f)) {
      throw new Error(`migration file name must look like 0001_name.sql: ${f}`);
    }
  }
  files.sort();

  const newlyApplied: string[] = [];
  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    const sha256 = createHash('sha256').update(sql).digest('hex');
    const known = applied.get(file);
    if (known !== undefined) {
      if (known !== sha256) {
        throw new Error(
          `migration ${file} changed after it was applied; add a new migration instead`,
        );
      }
      continue;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, sha256) VALUES (?, ?)').run(file, sha256);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    newlyApplied.push(file);
  }
  return newlyApplied;
}
