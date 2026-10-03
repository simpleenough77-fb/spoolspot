// SPDX-License-Identifier: AGPL-3.0-or-later
// CI check: every dependency in the lockfile (including dev tooling) meets the license policy.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { evaluate, type LicenseEntry, type LicenseException } from './lib/licenses.ts';

const raw = execFileSync('pnpm', ['licenses', 'list', '--json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const byLicense = JSON.parse(raw) as Record<string, { name: string; versions: string[] }[]>;
const entries: LicenseEntry[] = Object.entries(byLicense).flatMap(([license, pkgs]) =>
  pkgs.map((p) => ({ name: p.name, versions: p.versions, license })),
);

const exceptionsFile = '.license-exceptions.json';
const exceptions = existsSync(exceptionsFile)
  ? (JSON.parse(readFileSync(exceptionsFile, 'utf8')) as { exceptions: LicenseException[] })
      .exceptions
  : [];

const today = new Date().toISOString().slice(0, 10);
const report = evaluate(entries, exceptions, today);

for (const line of report.exceptionsUsed) console.log(`exception in use: ${line}`);
for (const line of report.staleExceptions) console.warn(`::warning::${line}`);
if (report.failures.length > 0) {
  for (const line of report.failures) console.error(`::error::${line}`);
  process.exit(1);
}
console.log(`${String(entries.length)} licenses checked against ADR-0002.`);
