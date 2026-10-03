// SPDX-License-Identifier: AGPL-3.0-or-later
// CI check: tracked source files carry an SPDX-License-Identifier header.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hasHeader, needsHeader } from './lib/spdx.ts';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((p) => p !== '');
const missing = tracked.filter((p) => needsHeader(p) && !hasHeader(readFileSync(p, 'utf8')));

if (missing.length > 0) {
  for (const p of missing)
    console.error(`::error file=${p}::missing SPDX-License-Identifier header`);
  process.exit(1);
}
console.log('All tracked source files carry an SPDX header.');
