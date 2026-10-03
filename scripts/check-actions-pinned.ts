// SPDX-License-Identifier: AGPL-3.0-or-later
// CI check: GitHub Actions workflows and composite actions are pinned by commit SHA, and
// workflows start with no write permissions.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkWorkflow } from './lib/workflows.ts';

const isYaml = (f: string) => f.endsWith('.yml') || f.endsWith('.yaml');

const workflowDir = '.github/workflows';
const workflows = readdirSync(workflowDir)
  .filter(isYaml)
  .map((f) => join(workflowDir, f));

const actionsDir = '.github/actions';
const actions = existsSync(actionsDir)
  ? readdirSync(actionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) =>
        readdirSync(join(actionsDir, d.name))
          .filter(isYaml)
          .map((f) => join(actionsDir, d.name, f)),
      )
  : [];

const problems = [
  ...workflows.flatMap((f) => checkWorkflow(f, readFileSync(f, 'utf8'))),
  ...actions.flatMap((f) =>
    checkWorkflow(f, readFileSync(f, 'utf8'), { requirePermissions: false }),
  ),
];

if (problems.length > 0) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
console.log(
  `${String(workflows.length)} workflow(s) and ${String(actions.length)} composite action(s) checked: all pinned, no top-level write.`,
);
