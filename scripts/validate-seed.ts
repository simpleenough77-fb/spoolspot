// SPDX-License-Identifier: AGPL-3.0-or-later
// Usage: node scripts/validate-seed.ts [seed.json] [schema.json]
import { readFileSync } from 'node:fs';
import { validateSeed } from '../app/src/seed/validate.ts';

const seedPath = process.argv[2] ?? 'seed/locations-seed.json';
const schemaPath = process.argv[3] ?? 'schema/locations-seed.schema.json';

const seed: unknown = JSON.parse(readFileSync(seedPath, 'utf8'));
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object;
const issues = validateSeed(seed, schema);

if (issues.length > 0) {
  console.error(`${seedPath} is invalid against ${schemaPath}:`);
  for (const issue of issues) console.error(`  ${issue.path}: ${issue.message}`);
  process.exit(1);
}
console.log(`${seedPath} is valid against ${schemaPath}.`);
