// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { checkWorkflow } from './workflows.ts';

const sha = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const good = `name: x
permissions: {}
jobs:
  a:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${sha} # v7.0.1
      - uses: $/.github/actions/local
`;

describe('checkWorkflow', () => {
  it('accepts pinned actions and empty permissions', () => {
    expect(checkWorkflow('ci.yml', good)).toEqual([]);
  });

  it('flags an action pinned by tag', () => {
    const bad = good.replace(`@${sha} # v7.0.1`, '@v7');
    expect(checkWorkflow('ci.yml', bad)).toHaveLength(1);
  });

  it('flags a SHA pin with no version comment', () => {
    const bad = good.replace(' # v7.0.1', '');
    expect(checkWorkflow('ci.yml', bad)[0]).toContain('comment');
  });

  it('flags a branch ref', () => {
    expect(checkWorkflow('ci.yml', good.replace(`@${sha} # v7.0.1`, '@main'))).toHaveLength(1);
  });

  it('flags missing top-level permissions', () => {
    expect(checkWorkflow('ci.yml', good.replace('permissions: {}\n', ''))).toHaveLength(1);
  });

  it('flags top-level write permissions', () => {
    const bad = good.replace('permissions: {}', 'permissions:\n  contents: write');
    expect(checkWorkflow('ci.yml', bad)).toHaveLength(1);
  });

  it('accepts top-level read permissions', () => {
    const ok = good.replace('permissions: {}', 'permissions:\n  contents: read');
    expect(checkWorkflow('ci.yml', ok)).toEqual([]);
  });

  it('ignores job-level write permissions (jobs may need them)', () => {
    const ok = good.replace('  a:\n', '  a:\n    permissions:\n      security-events: write\n');
    expect(checkWorkflow('ci.yml', ok)).toEqual([]);
  });

  it('checks pins but not permissions for composite actions', () => {
    const composite = `runs:
  using: composite
  steps:
    - uses: actions/checkout@${sha} # v7.0.1
`;
    expect(checkWorkflow('action.yml', composite, { requirePermissions: false })).toEqual([]);
    expect(
      checkWorkflow('action.yml', composite.replace(`@${sha} # v7.0.1`, '@v7'), {
        requirePermissions: false,
      }),
    ).toHaveLength(1);
  });
});
