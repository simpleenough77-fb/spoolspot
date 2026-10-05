// SPDX-License-Identifier: AGPL-3.0-or-later
// Usage: node scripts/validate-catalog.ts [catalog.json] [schema.json]
import { readFileSync } from 'node:fs';
import { validateCatalog } from '../app/src/catalog/validate.ts';

const path = process.argv[2] ?? 'seed/catalog-sample.json';
const schemaPath = process.argv[3] ?? 'schema/catalog.schema.json';
const doc: unknown = JSON.parse(readFileSync(path, 'utf8'));
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object;
const issues = validateCatalog(doc, schema);
if (issues.length > 0) {
  console.error(`${path} is invalid against ${schemaPath}:`);
  for (const issue of issues) console.error(`  ${issue.path}: ${issue.message}`);
  process.exit(1);
}
console.log(`${path} is valid against ${schemaPath}.`);
