// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Sql } from '../db/sql.ts';
import { memoryDatabase, readJson, TENANT_A, TENANT_B } from '../testing.ts';
import { CatalogInvalidError, importCatalog } from './import.ts';
import { validateCatalog, type CatalogDocument } from './validate.ts';

const schema = readJson('schema/catalog.schema.json');
const sample = (): CatalogDocument =>
  JSON.parse(readFileSync('seed/catalog-sample.json', 'utf8')) as CatalogDocument;
const ONE = 'abcdef01-1111-4111-8111-111111111111';
const entry = (over: Partial<CatalogDocument['filaments'][number]> = {}) => ({
  id: ONE,
  manufacturer: 'M',
  type: 'PLA',
  color: 'Black',
  spool_kind: 'disposable' as const,
  ...over,
});
const doc = (...filaments: ReturnType<typeof entry>[]): CatalogDocument => ({
  version: '0.1',
  generated: '2026-10-05',
  filaments,
});

describe('validateCatalog', () => {
  it('accepts the sample catalog', () => {
    expect(validateCatalog(sample(), schema)).toEqual([]);
  });

  it.each([
    ['an uppercase uuid', entry({ id: ONE.toUpperCase() })],
    ['a missing field', { id: ONE, manufacturer: 'M', type: 'PLA', color: 'Black' }],
    ['an unknown spool kind', entry({ spool_kind: 'other' as 'disposable' })],
    ['an extra field (weight is never stored)', { ...entry(), weight: 1000 }],
    ['an empty color', entry({ color: '' })],
    ['a leading space', entry({ color: ' Black' })],
    ['a control character', entry({ color: 'Bla\u0000ck' })],
    ['a newline', entry({ color: 'Bla\nck' })],
    ['a color over 80 characters', entry({ color: 'x'.repeat(81) })],
  ])('rejects %s', (_name, bad) => {
    const issues = validateCatalog({ ...doc(), filaments: [bad] }, schema);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('rejects an empty catalog, a wrong version and an extra top-level key', () => {
    expect(validateCatalog({ ...doc(), filaments: [] }, schema).length).toBeGreaterThan(0);
    expect(validateCatalog({ ...doc(entry()), version: 'x' }, schema).length).toBeGreaterThan(0);
    expect(validateCatalog({ ...doc(entry()), extra: 1 }, schema).length).toBeGreaterThan(0);
  });

  it('rejects duplicate ids and the same manufacturer, type and color in any letter case', () => {
    const dupId = validateCatalog(doc(entry(), entry({ color: 'White' })), schema);
    expect(dupId.map((i) => i.message).join()).toContain('duplicate id');
    const other = '22222222-2222-4222-8222-222222222222';
    const dupName = validateCatalog(doc(entry(), entry({ id: other, color: 'black' })), schema);
    expect(dupName.map((i) => i.message).join()).toContain('same manufacturer, type and color');
  });
});

describe('importCatalog', () => {
  it('imports the sample catalog as filaments with the moderate default level', async () => {
    const { db, sql } = memoryDatabase();
    const result = await importCatalog(sql, TENANT_A, sample(), schema);
    expect(result).toEqual({ inserted: 14, skipped: 0, differing: 0, differing_ids: [] });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM filament WHERE tenant_id = ?').get(TENANT_A),
    ).toMatchObject({ n: 14 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM filament WHERE reorder_level = 'moderate' AND auto_level = 0",
        )
        .get(),
    ).toMatchObject({ n: 14 });
    expect(db.prepare('SELECT COUNT(DISTINCT spool_kind) AS n FROM filament').get()).toMatchObject({
      n: 2,
    });
  });

  it('keeps the catalog id as the filament id', async () => {
    const { db, sql } = memoryDatabase();
    const catalog = sample();
    await importCatalog(sql, TENANT_A, catalog, schema);
    const ids = (db.prepare('SELECT id FROM filament').all() as { id: string }[]).map((r) => r.id);
    expect(new Set(ids)).toEqual(new Set(catalog.filaments.map((f) => f.id)));
  });

  it("is repeatable: the second run changes nothing and never overwrites a person's level", async () => {
    const { db, sql } = memoryDatabase();
    const catalog = sample();
    const firstId = catalog.filaments[0]?.id ?? '';
    await importCatalog(sql, TENANT_A, catalog, schema);
    db.prepare("UPDATE filament SET reorder_level = 'high' WHERE id = ?").run(firstId);
    const again = await importCatalog(sql, TENANT_A, catalog, schema);
    expect(again).toEqual({ inserted: 0, skipped: 14, differing: 0, differing_ids: [] });
    expect(
      db.prepare('SELECT reorder_level FROM filament WHERE id = ?').get(firstId),
    ).toMatchObject({ reorder_level: 'high' });
  });

  it('reports a known id with different details and leaves it unchanged', async () => {
    const { db, sql } = memoryDatabase();
    await importCatalog(sql, TENANT_A, doc(entry()), schema);
    const result = await importCatalog(
      sql,
      TENANT_A,
      doc(entry({ spool_kind: 'refillable' })),
      schema,
    );
    expect(result).toEqual({ inserted: 0, skipped: 1, differing: 1, differing_ids: [ONE] });
    expect(db.prepare('SELECT spool_kind FROM filament').get()).toMatchObject({
      spool_kind: 'disposable',
    });
  });

  it('refuses a new id for a manufacturer, type and color that already exist, and stores nothing', async () => {
    const { db, sql } = memoryDatabase();
    await importCatalog(sql, TENANT_A, doc(entry()), schema);
    const other = '22222222-2222-4222-8222-222222222222';
    const third = '33333333-3333-4333-8333-333333333333';
    await expect(
      importCatalog(
        sql,
        TENANT_A,
        doc(entry({ id: third, color: 'Red' }), entry({ id: other })),
        schema,
      ),
    ).rejects.toBeInstanceOf(CatalogInvalidError);
    expect(db.prepare('SELECT COUNT(*) AS n FROM filament').get()).toMatchObject({ n: 1 });
  });

  it('writes nothing when the document is invalid', async () => {
    const { db, sql } = memoryDatabase();
    await expect(importCatalog(sql, TENANT_A, { nope: true }, schema)).rejects.toBeInstanceOf(
      CatalogInvalidError,
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM filament').get()).toMatchObject({ n: 0 });
  });

  it('keeps tenants apart: the same catalog imports into each', async () => {
    const { db, sql } = memoryDatabase();
    const catalog = sample();
    await importCatalog(sql, TENANT_A, catalog, schema);
    expect(await importCatalog(sql, TENANT_B, catalog, schema)).toMatchObject({ inserted: 14 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM filament').get()).toMatchObject({ n: 28 });
  });

  it('imports more rows than one statement holds (bound-parameter limit)', async () => {
    const { db, sql } = memoryDatabase();
    const many = Array.from({ length: 40 }, (_, i) =>
      entry({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        color: `Color ${String(i)}`,
      }),
    );
    expect(await importCatalog(sql, TENANT_A, doc(...many), schema)).toMatchObject({
      inserted: 40,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM filament').get()).toMatchObject({ n: 40 });
  });

  it('treats a case or Unicode variant of an existing name as the same filament and stores nothing', async () => {
    const { db, sql } = memoryDatabase();
    await importCatalog(sql, TENANT_A, doc(entry({ color: 'Black' })), schema);
    const other = '22222222-2222-4222-8222-222222222222';
    await expect(
      importCatalog(sql, TENANT_A, doc(entry({ id: other, color: 'black' })), schema),
    ).rejects.toBeInstanceOf(CatalogInvalidError);
    expect(db.prepare('SELECT COUNT(*) AS n FROM filament').get()).toMatchObject({ n: 1 });
  });

  it('reports what was really added, and a filament added after the check is a clean refusal', async () => {
    const { db, sql } = memoryDatabase();
    const racing: Sql = {
      all: (q, p) => sql.all(q, p),
      batch: (statements) => {
        db.prepare('INSERT INTO tenant_settings (tenant_id) VALUES (?) ON CONFLICT DO NOTHING').run(
          TENANT_A,
        );
        db.prepare(
          "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, '33333333-3333-4333-8333-333333333333', 'M', 'PLA', 'Black', 'disposable')",
        ).run(TENANT_A);
        return sql.batch(statements);
      },
    };
    await expect(importCatalog(racing, TENANT_A, doc(entry()), schema)).rejects.toBeInstanceOf(
      CatalogInvalidError,
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM filament').get()).toMatchObject({ n: 1 });
  });

  it('rejects more than 5000 filaments', () => {
    const many = Array.from({ length: 5001 }, (_, i) =>
      entry({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        color: `C${String(i)}`,
      }),
    );
    expect(validateCatalog(doc(...many), schema).length).toBeGreaterThan(0);
  });
});

describe('names that look alike or read backwards', () => {
  it.each([
    ['a zero-width space', 'Bla\u200Bck'],
    ['a right-to-left override', 'Bla\u202Eck'],
    ['a bidi isolate', 'Bla\u2066ck'],
    ['a byte order mark', '\uFEFFBlack'],
    ['a soft hyphen', 'Bla\u00ADck'],
    ['a C1 control', 'Bla\u0090ck'],
    ['a non-breaking space', 'Black\u00A0Red'],
    ['a trailing no-break space', 'Black\u00A0'],
    ['an ideographic space', 'Black\u3000Red'],
    ['a private-use character', 'Bla\uE000ck'],
    ['a lone surrogate', 'Bla\ud800ck'],
    ['a decomposed accent (not NFC)', 'Cafe\u0301'],
  ])('rejects %s', (_name, color) => {
    const issues = validateCatalog(doc(entry({ color })), schema);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('accepts ordinary accents, emoji and a single inner space', () => {
    expect(validateCatalog(doc(entry({ color: 'Café Noir' })), schema)).toEqual([]);
    expect(validateCatalog(doc(entry({ color: 'Sunset 🌅' })), schema)).toEqual([]);
  });

  it('treats NFC and NFD spellings of one name as duplicates', () => {
    const other = '22222222-2222-4222-8222-222222222222';
    // The second spelling is rejected as not-NFC; the point is that it can never slip in as a twin.
    const issues = validateCatalog(
      doc(entry({ color: 'Café' }), entry({ id: other, color: 'Cafe\u0301' })),
      schema,
    );
    expect(issues.length).toBeGreaterThan(0);
  });
});
