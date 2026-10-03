// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { checkBranch, checkCommit, checkTitle } from './policy.ts';

const human = 'avi';
const signoff = 'Body text.\n\nSigned-off-by: Avi Example <avi@example.com>';

describe('checkBranch', () => {
  it('accepts SPOOL-<n>-short-description', () => {
    expect(checkBranch('SPOOL-33-ci-skeleton', human)).toEqual([]);
  });
  it.each([
    'main',
    'spool-33-ci',
    'SPOOL-33',
    'SPOOL-0-x',
    'SPOOL-33-Bad_Case',
    'feature/SPOOL-33-x',
  ])('rejects %s', (ref) => {
    expect(checkBranch(ref, human)).toHaveLength(1);
  });
  it('accepts dependabot branches only for dependabot', () => {
    expect(checkBranch('dependabot/npm_and_yarn/x-1.2.3', 'dependabot[bot]')).toEqual([]);
    expect(checkBranch('dependabot/npm_and_yarn/x-1.2.3', human)).toHaveLength(1);
    expect(checkBranch('feature/x', 'dependabot[bot]')).toHaveLength(1);
  });
});

describe('checkTitle', () => {
  it('accepts a conventional title with a key', () => {
    expect(checkTitle('ci: SPOOL-33 add CI skeleton', human)).toEqual([]);
    expect(checkTitle('feat(api)!: SPOOL-22 SPOOL-23 change the schema', human)).toEqual([]);
  });
  it.each([
    'add CI skeleton',
    'ci: add CI skeleton',
    'ci: SPOOL-33',
    'ci:SPOOL-33 add',
    'wip: SPOOL-33 add',
    'ci: spool-33 add',
  ])('rejects "%s"', (title) => {
    expect(checkTitle(title, human)).toHaveLength(1);
  });
  it('accepts a GitHub-made revert of a keyed title', () => {
    expect(checkTitle('Revert "ci: SPOOL-33 add CI skeleton"', human)).toEqual([]);
  });
  it('does not require a key from dependabot', () => {
    expect(checkTitle('chore(deps): bump x from 1 to 2', 'dependabot[bot]')).toEqual([]);
  });
});

describe('checkCommit', () => {
  const base = { sha: 'abcdef1234567', author: human };
  it('accepts a keyed, signed-off commit', () => {
    expect(checkCommit({ ...base, subject: 'ci: SPOOL-33 add CI', body: signoff })).toEqual([]);
  });
  it('flags a missing key and a missing sign-off', () => {
    const problems = checkCommit({ ...base, subject: 'ci: add CI', body: 'Body.' });
    expect(problems).toHaveLength(2);
  });
  it('flags a malformed sign-off', () => {
    expect(
      checkCommit({
        ...base,
        subject: 'ci: SPOOL-33 add CI',
        body: 'Signed-off-by: nobody',
      }),
    ).toHaveLength(1);
  });
  it('exempts dependabot commits', () => {
    expect(
      checkCommit({
        sha: 'abcdef1234567',
        author: 'dependabot[bot]',
        subject: 'Bump x',
        body: '',
      }),
    ).toEqual([]);
  });
});
