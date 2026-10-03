// SPDX-License-Identifier: AGPL-3.0-or-later
// REUSE-IgnoreStart (this file mentions SPDX tags as test data and in a pattern)
// ADR-0002 decision 1: source files carry SPDX license identifiers. Data and prose files are
// covered by REUSE.toml instead, because they cannot all hold comments.

export const CODE_EXTENSIONS = ['.ts', '.js', '.mjs', '.cjs', '.sh', '.yml', '.yaml', '.py'];

/** Generated lockfiles cannot carry a header. */
const EXEMPT = ['pnpm-lock.yaml'];

export function needsHeader(path: string): boolean {
  return (
    CODE_EXTENSIONS.some((ext) => path.endsWith(ext)) &&
    !path.startsWith('LICENSES/') &&
    !EXEMPT.includes(path)
  );
}

export function hasHeader(text: string): boolean {
  return text
    .split('\n')
    .slice(0, 5)
    .some((l) => /SPDX-License-Identifier:\s*\S+/.test(l));
}
// REUSE-IgnoreEnd
