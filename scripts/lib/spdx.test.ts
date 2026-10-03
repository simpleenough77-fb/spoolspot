// SPDX-License-Identifier: AGPL-3.0-or-later
// REUSE-IgnoreStart (this file mentions SPDX tags as test data and in a pattern)
import { describe, expect, it } from 'vitest';
import { hasHeader, needsHeader } from './spdx.ts';

describe('spdx header rule', () => {
  it('finds a header in the first lines', () => {
    expect(hasHeader('#!/bin/sh\n# SPDX-License-Identifier: AGPL-3.0-or-later\n')).toBe(true);
    expect(hasHeader('// SPDX-License-Identifier: CC0-1.0\nexport {};\n')).toBe(true);
  });
  it('flags a missing header', () => {
    expect(hasHeader('export {};\n')).toBe(false);
    expect(hasHeader('\n\n\n\n\n// SPDX-License-Identifier: AGPL-3.0-or-later\n')).toBe(false);
  });
  it('applies to code files only', () => {
    expect(needsHeader('scripts/a.ts')).toBe(true);
    expect(needsHeader('.github/workflows/ci.yml')).toBe(true);
    expect(needsHeader('README.md')).toBe(false);
    expect(needsHeader('seed/locations-seed.json')).toBe(false);
    expect(needsHeader('pnpm-lock.yaml')).toBe(false);
  });
});
// REUSE-IgnoreEnd
