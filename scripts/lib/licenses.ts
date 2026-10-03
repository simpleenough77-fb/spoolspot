// SPDX-License-Identifier: AGPL-3.0-or-later
// Dependency license policy from ADR-0002 decision 7.

/** MIT, BSD, ISC, Apache-2.0, 0BSD, CC0; MPL-2.0 and LGPL only as unmodified libraries. */
export const ALLOWED = new Set([
  'MIT',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'Apache-2.0',
  '0BSD',
  'CC0-1.0',
  'MPL-2.0',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
]);

/** Blocked outright. An exception cannot override these. */
const BLOCKED = [
  /^GPL-2\.0(-only)?$/,
  /^SSPL/,
  /^BUSL/,
  /^Elastic/,
  /(^|-)NC(-|$)/,
  /^UNLICENSED$/i,
  /^UNKNOWN$/i,
  /^SEE LICENSE/i,
];

export interface LicenseEntry {
  name: string;
  versions: string[];
  license: string;
}

export interface LicenseException {
  package: string; // name@version
  license: string;
  reason: string;
  owner: string;
  approved_by: string;
  ref: string; // where the written risk acceptance lives
  expires: string; // YYYY-MM-DD
}

export interface LicenseReport {
  failures: string[];
  exceptionsUsed: string[];
  staleExceptions: string[];
}

export function isBlocked(license: string): boolean {
  return BLOCKED.some((re) => re.test(license.trim()));
}

/** SPDX expressions: OR picks one alternative, AND needs all. WITH is not allowed. */
export function isAllowed(expression: string): boolean {
  const stripped = expression.replace(/[()]/g, ' ').trim();
  if (stripped === '' || /\bWITH\b/.test(stripped)) return false;
  return stripped.split(/\s+OR\s+/).some((alt) =>
    alt
      .split(/\s+AND\s+/)
      .map((id) => id.trim())
      .every((id) => ALLOWED.has(id)),
  );
}

function expressionBlocked(expression: string): boolean {
  const ids = expression
    .replace(/[()]/g, ' ')
    .split(/\s+(?:OR|AND)\s+/)
    .map((s) => s.trim());
  // Blocked only when no allowed alternative exists.
  return !isAllowed(expression) && ids.some((id) => isBlocked(id));
}

export function evaluate(
  entries: LicenseEntry[],
  exceptions: LicenseException[],
  today: string,
): LicenseReport {
  const failures: string[] = [];
  const exceptionsUsed: string[] = [];
  const used = new Set<string>();

  for (const entry of entries) {
    for (const version of entry.versions) {
      const id = `${entry.name}@${version}`;
      if (isAllowed(entry.license)) continue;
      if (expressionBlocked(entry.license)) {
        failures.push(`${id}: license "${entry.license}" is blocked (ADR-0002).`);
        continue;
      }
      const ex = exceptions.find((e) => e.package === id && e.license === entry.license);
      if (ex) used.add(id);
      if (!ex) {
        failures.push(
          `${id}: license "${entry.license}" is not allowed (ADR-0002); needs a written exception.`,
        );
      } else if (/^PENDING/i.test(ex.approved_by)) {
        failures.push(`${id}: exception is not approved yet (${ex.approved_by}).`);
      } else if (ex.expires < today) {
        failures.push(`${id}: exception expired on ${ex.expires}.`);
      } else {
        exceptionsUsed.push(`${id} (${entry.license}) until ${ex.expires}: ${ex.reason}`);
      }
    }
  }
  const staleExceptions = exceptions
    .filter((e) => !used.has(e.package))
    .map((e) => `${e.package}: exception is no longer needed; remove it.`);
  return { failures, exceptionsUsed, staleExceptions };
}
