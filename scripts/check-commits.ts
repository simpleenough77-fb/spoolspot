// SPDX-License-Identifier: AGPL-3.0-or-later
// CI check: every non-merge commit in BASE_SHA..HEAD_SHA has a keyed subject and a DCO sign-off.
import { execFileSync } from 'node:child_process';
import { checkCommit, type CommitInfo } from './lib/policy.ts';

const base = process.env.BASE_SHA ?? '';
const head = process.env.HEAD_SHA ?? '';
if (!/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) {
  console.error('BASE_SHA and HEAD_SHA must be 40-character commit ids.');
  process.exit(2);
}

// Fields separated by 0x1f, records by 0x1e.
const raw = execFileSync(
  'git',
  ['log', '--no-merges', '--format=%H%x1f%an%x1f%s%x1f%b%x1e', `${base}..${head}`],
  { encoding: 'utf8' },
);
const commits: CommitInfo[] = raw
  .split('\x1e')
  .map((r) => r.trim())
  .filter((r) => r !== '')
  .map((r) => {
    const [sha = '', author = '', subject = '', body = ''] = r.split('\x1f');
    return { sha, author, subject, body };
  });

const problems = commits.flatMap((c) => checkCommit(c));
if (problems.length > 0) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
console.log(`${String(commits.length)} commit(s) checked: keys and sign-offs are present.`);
