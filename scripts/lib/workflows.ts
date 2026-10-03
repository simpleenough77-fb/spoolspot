// SPDX-License-Identifier: AGPL-3.0-or-later
// Workflow hygiene: every action pinned by full commit SHA with a version comment, and a
// top-level `permissions` block that grants no write access (project rule 5; SPOOL-71).

const USES_RE = /^\s*(?:-\s+)?uses:\s*(\S+)(?:\s+#\s*(.*))?$/;
const SHA_PIN_RE = /^[^@\s]+@[0-9a-f]{40}$/;
const VERSION_COMMENT_RE = /^v?\d+(\.\d+){0,2}\b/;

export function checkWorkflow(
  file: string,
  text: string,
  options: { requirePermissions: boolean } = { requirePermissions: true },
): string[] {
  const problems: string[] = [];
  const lines = text.split('\n');

  lines.forEach((line, i) => {
    const m = USES_RE.exec(line);
    if (!m) return;
    const target = m[1] ?? '';
    const comment = m[2] ?? '';
    const at = `${file}:${String(i + 1)}`;
    if (target.startsWith('./') || target.startsWith('$/')) return; // action in this repository
    if (!SHA_PIN_RE.test(target)) {
      problems.push(`${at}: "${target}" is not pinned to a full commit SHA.`);
    } else if (!VERSION_COMMENT_RE.test(comment)) {
      problems.push(`${at}: "${target}" needs a trailing "# vX.Y.Z" comment.`);
    }
  });

  if (!options.requirePermissions) return problems; // composite actions have no permissions block

  const top = topLevelPermissions(lines);
  if (top === undefined) {
    problems.push(`${file}: missing top-level "permissions:" (use "permissions: {}").`);
  } else if (top.some((v) => v === 'write')) {
    problems.push(`${file}: top-level permissions must not grant write access.`);
  }
  return problems;
}

/** Values granted by the top-level permissions block; undefined when the block is absent. */
function topLevelPermissions(lines: string[]): string[] | undefined {
  const start = lines.findIndex((l) => l.startsWith('permissions:'));
  if (start < 0) return undefined;
  const inline = /^permissions:\s*(\S.*)$/.exec(lines[start] ?? '');
  if (inline) return [(inline[1] ?? '').trim()];
  const values: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) break;
    const m = /^\s+[\w-]+:\s*(\S+)/.exec(line);
    if (m) values.push(m[1] ?? '');
  }
  return values;
}
