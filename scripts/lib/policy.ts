// SPDX-License-Identifier: AGPL-3.0-or-later
// Traceability and DCO rules (project instructions: branches, commits and PR titles carry the
// SPOOL key; ADR-0002: every commit is signed off under the DCO).

export const COMMIT_TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
] as const;

const KEY = 'SPOOL-[1-9][0-9]*';

/** type(scope)!: SPOOL-12 subject */
export const SUBJECT_RE = new RegExp(
  `^(?:${COMMIT_TYPES.join('|')})(?:\\([a-z0-9-]+\\))?!?: ${KEY}(?: ${KEY})* \\S.*$`,
);
/** Revert commits made by the GitHub UI keep the original subject, which carries the key. */
const REVERT_RE = new RegExp(`^Revert ".*\\b${KEY}\\b.*"$`);
/** SPOOL-12-short-description */
export const BRANCH_RE = new RegExp(`^${KEY}-[a-z0-9]+(?:-[a-z0-9]+)*$`);
export const SIGNOFF_RE = /^Signed-off-by: \S.* <[^<>\s@]+@[^<>\s@]+>$/m;

/** Automated dependency updates have no ticket of their own and no human to sign off. */
export const BOT_AUTHORS: readonly string[] = ['dependabot[bot]'];

export function isBot(author: string): boolean {
  return BOT_AUTHORS.includes(author);
}

export function checkBranch(ref: string, prAuthor: string): string[] {
  if (isBot(prAuthor)) {
    return ref.startsWith('dependabot/')
      ? []
      : [`Bot-authored branch "${ref}" must start with "dependabot/".`];
  }
  return BRANCH_RE.test(ref)
    ? []
    : [`Branch "${ref}" must match SPOOL-<n>-short-description (lowercase, hyphens).`];
}

export function checkTitle(title: string, prAuthor: string): string[] {
  if (isBot(prAuthor)) return [];
  return SUBJECT_RE.test(title) || REVERT_RE.test(title)
    ? []
    : [`Title "${title}" must look like "type(scope): SPOOL-<n> subject".`];
}

export interface CommitInfo {
  sha: string;
  author: string;
  subject: string;
  body: string;
}

export function checkCommit(c: CommitInfo): string[] {
  if (isBot(c.author)) return [];
  const problems: string[] = [];
  const short = c.sha.slice(0, 7);
  if (!SUBJECT_RE.test(c.subject) && !REVERT_RE.test(c.subject)) {
    problems.push(
      `${short}: subject "${c.subject}" must look like "type(scope): SPOOL-<n> subject".`,
    );
  }
  if (!SIGNOFF_RE.test(c.body)) {
    problems.push(`${short}: missing "Signed-off-by: Name <email>" (use git commit -s).`);
  }
  return problems;
}
