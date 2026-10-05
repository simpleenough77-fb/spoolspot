// SPDX-License-Identifier: AGPL-3.0-or-later
// Imports a filament catalog into one tenant. Validated first; one atomic batch; adds filaments that are
// missing and never overwrites one that exists (a person's reorder level and history stay theirs), so
// importing the same catalog again changes nothing. A catalog entry that has a known id but different
// details is reported, not applied. A new id whose manufacturer, type and color already exist under
// another id is refused as a whole (it would be a second copy of one filament).
import type { Sql, SqlParam, Statement } from '../db/sql.ts';
import {
  filamentKey,
  validateCatalog,
  type CatalogDocument,
  type CatalogIssue,
} from './validate.ts';

export interface CatalogImportResult {
  inserted: number;
  skipped: number;
  /** Known ids whose details differ from the catalog; left unchanged. */
  differing: number;
  /** The first of those ids (at most 20), so the person can see which. */
  differing_ids: string[];
}

export class CatalogInvalidError extends Error {
  readonly issues: readonly CatalogIssue[];
  constructor(issues: readonly CatalogIssue[]) {
    super(`catalog is invalid: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
    this.name = 'CatalogInvalidError';
    this.issues = issues;
  }
}

const COLUMNS = ['tenant_id', 'id', 'manufacturer', 'type', 'color', 'spool_kind'] as const;
// D1 allows 100 bound parameters per query: 16 rows x 6 columns = 96.
const ROWS_PER_STATEMENT = 16;

interface Existing {
  id: string;
  manufacturer: string;
  type: string;
  color: string;
  spool_kind: string;
}

export async function importCatalog(
  sql: Sql,
  tenantId: string,
  doc: unknown,
  schema: object,
): Promise<CatalogImportResult> {
  const issues = validateCatalog(doc, schema);
  if (issues.length > 0) throw new CatalogInvalidError(issues);
  const catalog = doc as CatalogDocument;

  const existing = await sql.all<Existing>(
    'SELECT id, manufacturer, type, color, spool_kind FROM filament WHERE tenant_id = ?',
    [tenantId],
  );
  const byId = new Map(existing.map((e) => [e.id, e]));
  const byName = new Map(existing.map((e) => [filamentKey(e), e.id]));

  const missing: CatalogDocument['filaments'] = [];
  const conflicts: CatalogIssue[] = [];
  const differingIds: string[] = [];
  catalog.filaments.forEach((f, i) => {
    const known = byId.get(f.id);
    if (known) {
      if (
        known.manufacturer !== f.manufacturer ||
        known.type !== f.type ||
        known.color !== f.color ||
        known.spool_kind !== f.spool_kind
      ) {
        differingIds.push(f.id);
      }
      return;
    }
    const sameName = byName.get(filamentKey(f));
    if (sameName !== undefined) {
      conflicts.push({
        path: `/filaments/${String(i)}`,
        message: 'this manufacturer, type and color already exist here under a different id',
      });
      return;
    }
    missing.push(f);
  });
  if (conflicts.length > 0) throw new CatalogInvalidError(conflicts.slice(0, 50));

  const statements: Statement[] = [
    {
      query:
        'INSERT INTO tenant_settings (tenant_id) VALUES (?) ON CONFLICT (tenant_id) DO NOTHING',
      params: [tenantId],
    },
  ];
  for (let i = 0; i < missing.length; i += ROWS_PER_STATEMENT) {
    const rows = missing.slice(i, i + ROWS_PER_STATEMENT);
    const placeholders = `(${COLUMNS.map(() => '?').join(', ')})`;
    const params: SqlParam[] = rows.flatMap((r) => [
      tenantId,
      r.id,
      r.manufacturer,
      r.type,
      r.color,
      r.spool_kind,
    ]);
    statements.push({
      query: `INSERT INTO filament (${COLUMNS.join(', ')}) VALUES ${rows.map(() => placeholders).join(', ')}
              ON CONFLICT (tenant_id, id) DO NOTHING`,
      params,
    });
  }
  let changes: number[];
  try {
    changes = await sql.batch(statements);
  } catch (error) {
    // Another import or a person added a matching filament after we looked: nothing was stored.
    if (error instanceof Error && /UNIQUE|constraint/i.test(error.message)) {
      throw new CatalogInvalidError([
        {
          path: '/',
          message: 'the filaments changed while importing; nothing was stored, run it again',
        },
      ]);
    }
    throw error;
  }
  // The first statement is the tenant row; the rest are inserts, and report what they really added.
  const inserted = changes.slice(1).reduce((n, c) => n + c, 0);
  return {
    inserted,
    skipped: catalog.filaments.length - inserted,
    differing: differingIds.length,
    differing_ids: differingIds.slice(0, 20),
  };
}
