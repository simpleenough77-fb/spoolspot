// SPDX-License-Identifier: AGPL-3.0-or-later
// commit-msg hook: node scripts/check-commit-msg.ts <message-file>
import { readFileSync } from 'node:fs';
import { checkCommit } from './lib/policy.ts';

const file = process.argv[2];
if (file === undefined) {
  console.error('Usage: check-commit-msg.ts <message-file>');
  process.exit(2);
}

const lines = readFileSync(file, 'utf8')
  .split('\n')
  .filter((l) => !l.startsWith('#'));
const subject = lines[0] ?? '';
// Merge and fixup commits are rewritten before they reach a PR.
if (/^(Merge |fixup! |squash! )/.test(subject)) process.exit(0);

const problems = checkCommit({
  sha: '0000000',
  author: 'local',
  subject,
  body: lines.slice(1).join('\n'),
});
if (problems.length > 0) {
  for (const p of problems) console.error(p.replace(/^0000000: /, ''));
  console.error('Example: "feat(schema): SPOOL-22 add the location schema"');
  process.exit(1);
}
