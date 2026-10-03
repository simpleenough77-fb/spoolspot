# Development guide

## Prerequisites

- Node 24 LTS (pinned in `.node-version`; Node 22 is also tested) and pnpm 12 (pinned with a hash by `packageManager`; install with `sh scripts/install-pnpm.sh`; Corepack 0.34 cannot run pnpm 12).
- git, and a git identity set (`user.name`, `user.email`): commits are signed off with it.
- Or open the repository in the dev container (`.devcontainer/`).

## First run

```sh
sh scripts/install-pnpm.sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm hooks:install
sh scripts/install-gitleaks.sh
pnpm check
```

`pnpm check` runs lint, format check, type-check, tests, seed validation, workflow pin check and SPDX check. CI additionally runs the audit, license, OSV, secret, SBOM, IaC, accessibility and CodeQL jobs.

The accessibility scan (`pnpm a11y`) needs Chrome: set `CHROME_PATH` to a Chrome or Chromium binary if it is not installed in the default place.

## Hooks

- `pre-commit`: gitleaks on staged changes, Prettier, lint, type-check.
- `commit-msg`: ticket key and sign-off check.
- `prepare-commit-msg`: adds the `Signed-off-by` trailer.

## Commit convention

`type(scope): SPOOL-<n> summary`. Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert. Branch: `SPOOL-<n>-short-description`.

## Dependencies

Add exact versions (no ranges). pnpm refuses releases younger than 24 hours, git/tarball transitive dependencies and trust downgrades; install scripts do not run. Run `pnpm check:licenses` and `pnpm audit:deps` before opening a PR.

## Versioning and releases

SemVer, `0.y.z` until 1.0. Releases are annotated `vX.Y.Z` tags on `main` (tags are protected). The changelog is written by hand until release automation exists.

## GitHub settings as code

`infra/github/` holds the repository ruleset and the script that applies the settings. See its README.

## Jira linking

Jira links work from the ticket key: a branch named `SPOOL-<n>-...`, a commit subject, or a pull request title containing `SPOOL-<n>` appears in that ticket's Development panel once the GitHub for Jira app is connected to the repository. CI rejects a pull request whose branch or title has no key.
