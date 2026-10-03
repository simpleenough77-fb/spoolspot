// SPDX-License-Identifier: AGPL-3.0-or-later
// CI check: the PR branch and title carry a SPOOL ticket key.
// Input comes from environment variables so untrusted text is never interpolated into a shell.
import { checkBranch, checkTitle } from './lib/policy.ts';

const title = process.env.PR_TITLE ?? '';
const headRef = process.env.HEAD_REF ?? '';
const author = process.env.PR_AUTHOR ?? '';

if (title === '' || headRef === '' || author === '') {
  console.error('PR_TITLE, HEAD_REF and PR_AUTHOR must be set.');
  process.exit(2);
}

const problems = [...checkBranch(headRef, author), ...checkTitle(title, author)];
if (problems.length > 0) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
console.log('Branch name and PR title carry a SPOOL key.');
