// SPDX-License-Identifier: AGPL-3.0-or-later
// Imports a location seed into one tenant. The document is validated against its JSON Schema first;
// nothing is written if it is invalid. The write is a single atomic batch, and it only adds locations
// that are missing, so importing the same seed again changes nothing and never overwrites what the user
// has changed since (capacities, tags).
import type { Sql, SqlParam, Statement } from '../db/sql.ts';
import { validateSeed, type SeedDocument, type SeedLocation } from './validate.ts';

export interface ImportResult {
  inserted: number;
  skipped: number;
}

export class SeedInvalidError extends Error {
  readonly issues: readonly { path: string; message: string }[];
  constructor(issues: readonly { path: string; message: string }[]) {
    super(`seed is invalid: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
    this.name = 'SeedInvalidError';
    this.issues = issues;
  }
}

const COLUMNS = [
  'tenant_id',
  'id',
  'name',
  'type',
  'parent',
  'leaf',
  'capacity',
  'capacity_mode',
  'prefers_manufacturer',
  'tag_id',
  'tag_source',
] as const;

// D1 allows 100 bound parameters per query: 8 rows x 11 columns = 88.
const ROWS_PER_STATEMENT = 8;

/** Parents before children, so every row's parent exists when it is inserted. */
function parentsFirst(locations: readonly SeedLocation[]): SeedLocation[] {
  const byId = new Map(locations.map((l) => [l.id, l]));
  const depth = (l: SeedLocation): number => {
    let d = 0;
    for (let p = l.parent; p !== null; p = byId.get(p)?.parent ?? null) d += 1;
    return d;
  };
  return locations
    .map((l, index) => ({ l, index, d: depth(l) }))
    .sort((a, b) => a.d - b.d || a.index - b.index)
    .map((x) => x.l);
}

function insertStatement(tenantId: string, rows: readonly SeedLocation[]): Statement {
  const placeholders = `(${COLUMNS.map(() => '?').join(', ')})`;
  const params: SqlParam[] = rows.flatMap((r) => [
    tenantId,
    r.id,
    r.name,
    r.type,
    r.parent,
    r.leaf ? 1 : 0,
    r.capacity,
    r.capacity_mode,
    r.prefers_manufacturer,
    r.tag_id,
    r.tag_source,
  ]);
  return {
    // ON CONFLICT (not INSERT OR IGNORE): only an existing (tenant, id) row is skipped. Any other
    // violation (bad value, duplicate tag) fails the whole batch instead of being dropped silently.
    query: `INSERT INTO location (${COLUMNS.join(', ')}) VALUES ${rows.map(() => placeholders).join(', ')}
            ON CONFLICT (tenant_id, id) DO NOTHING`,
    params,
  };
}

export async function importSeed(
  sql: Sql,
  tenantId: string,
  seed: unknown,
  schema: object,
): Promise<ImportResult> {
  const issues = validateSeed(seed, schema);
  if (issues.length > 0) throw new SeedInvalidError(issues);
  const doc = seed as SeedDocument;

  const existing = new Set(
    (
      await sql.all<{ id: string }>('SELECT id FROM location WHERE tenant_id = ?', [tenantId])
    ).map((r) => r.id),
  );
  const ordered = parentsFirst(doc.locations);
  const missing = ordered.filter((l) => !existing.has(l.id));

  const statements: Statement[] = [
    {
      query: 'INSERT INTO tenant_settings (tenant_id) VALUES (?) ON CONFLICT (tenant_id) DO NOTHING',
      params: [tenantId],
    },
  ];
  for (let i = 0; i < missing.length; i += ROWS_PER_STATEMENT) {
    statements.push(insertStatement(tenantId, missing.slice(i, i + ROWS_PER_STATEMENT)));
  }
  await sql.batch(statements);
  return { inserted: missing.length, skipped: doc.locations.length - missing.length };
}
