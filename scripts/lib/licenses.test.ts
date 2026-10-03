// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { evaluate, isAllowed, type LicenseException } from './licenses.ts';

const entry = (name: string, license: string, version = '1.0.0') => ({
  name,
  versions: [version],
  license,
});
const today = '2026-10-02';

describe('isAllowed', () => {
  it.each(['MIT', 'ISC', 'Apache-2.0', '(MIT OR Apache-2.0)', 'MIT AND BSD-3-Clause', 'MPL-2.0'])(
    'allows %s',
    (l) => {
      expect(isAllowed(l)).toBe(true);
    },
  );
  it.each([
    'GPL-3.0-only',
    'AGPL-3.0-or-later',
    'BlueOak-1.0.0',
    'Unlicense',
    'MIT AND GPL-3.0-only',
    'Apache-2.0 WITH LLVM-exception',
    '',
  ])('does not allow %s', (l) => {
    expect(isAllowed(l)).toBe(false);
  });
  it('allows an OR with one allowed side', () => {
    expect(isAllowed('(GPL-3.0-only OR MIT)')).toBe(true);
  });
});

describe('evaluate', () => {
  it('passes allowed licenses', () => {
    expect(evaluate([entry('a', 'MIT')], [], today).failures).toEqual([]);
  });

  it('fails an incompatible license (planted GPL-2.0-only dependency)', () => {
    const r = evaluate([entry('evil', 'GPL-2.0-only')], [], today);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain('blocked');
  });

  it('fails an unlicensed package', () => {
    expect(evaluate([entry('x', 'UNLICENSED')], [], today).failures).toHaveLength(1);
  });

  it('fails a license that needs review when there is no exception', () => {
    expect(evaluate([entry('g', 'GPL-3.0-only')], [], today).failures).toHaveLength(1);
  });

  const ex: LicenseException = {
    package: 'minimatch@1.0.0',
    license: 'BlueOak-1.0.0',
    reason: 'dev tool',
    owner: 'avi',
    approved_by: 'avi',
    ref: 'ADR-0002 addendum',
    expires: '2026-12-31',
  };

  it('honours a valid exception', () => {
    const r = evaluate([entry('minimatch', 'BlueOak-1.0.0')], [ex], today);
    expect(r.failures).toEqual([]);
    expect(r.exceptionsUsed).toHaveLength(1);
  });

  it('fails an exception that is still pending approval', () => {
    const pending = { ...ex, approved_by: 'PENDING: Avi' };
    const r = evaluate([entry('minimatch', 'BlueOak-1.0.0')], [pending], today);
    expect(r.failures[0]).toContain('not approved');
  });

  it('fails an expired exception', () => {
    const r = evaluate([entry('minimatch', 'BlueOak-1.0.0')], [ex], '2027-01-01');
    expect(r.failures[0]).toContain('expired');
  });

  it('does not let an exception cover a different version', () => {
    const r = evaluate([entry('minimatch', 'BlueOak-1.0.0', '2.0.0')], [ex], today);
    expect(r.failures).toHaveLength(1);
  });

  it('never lets an exception override a blocked license', () => {
    const blocked = { ...ex, package: 'evil@1.0.0', license: 'GPL-2.0-only' };
    expect(evaluate([entry('evil', 'GPL-2.0-only')], [blocked], today).failures).toHaveLength(1);
  });

  it('reports stale exceptions', () => {
    expect(evaluate([], [ex], today).staleExceptions).toHaveLength(1);
  });
});
