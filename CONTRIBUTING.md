# Contributing to SpoolSpot

Thanks for helping. This project is small and security-minded, so the rules below are strict but short.

## Principles

- Track where things are, not how much is left. Weight, temperatures, cost and per-print usage are out of scope.
- Every field is set by a tap or derived from known data. A field that needs typing must be justified in the proposal.
- Secure by default; accessible by default (WCAG 2.2 AA); privacy by design.

## Workflow

1. Work starts from a ticket (SPOOL-n). Nothing is built without one. Outside contributors: open an issue and a maintainer will create the ticket.
2. Branch name: `SPOOL-<n>-short-description` (lowercase, hyphens), for example `SPOOL-22-seed-schema`.
3. Commit subject: `type(scope): SPOOL-<n> summary`, where type is one of `feat fix docs style refactor perf test build ci chore revert`. Example: `feat(schema): SPOOL-22 add location schema`.
4. Every commit is signed off: `git commit -s` (the Developer Certificate of Origin 1.1, https://developercertificate.org). The `prepare-commit-msg` hook adds the trailer for you.
5. Pull request title carries the key too; the description links the ticket and the relevant documentation page. Keep PRs small, with tests.
6. Merges are rebase-only after the `ci-gate` check passes. No bypass. While the project has a single maintainer, the maintainer merges their own pull requests, so the ruleset requires no approving review; the passing gate and resolved review threads are the enforced controls. Pull requests from other contributors are reviewed by the maintainer before merge. A second reviewer is planned before the hosted tier accepts real users.

## Local setup

See [docs/development.md](docs/development.md). In short: Node and pnpm as pinned (`sh scripts/install-pnpm.sh`), `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm hooks:install`, `sh scripts/install-gitleaks.sh`, then `pnpm check`.

## Gates (all must pass)

Lint, format, type-check, unit and security tests, seed-vs-schema validation, workflow pin check, SPDX headers, dependency audit (high and critical fail), license policy, OSV scan, dependency review, secret scan, SBOM, Checkov and zizmor and CodeQL static analysis, and an axe-core accessibility scan. A failing gate blocks the merge. An exception needs a written risk acceptance with an owner, an expiry (gate exceptions 90 days, risk acceptances 12 months) and the owner's sign-off.

## Dependencies

Every dependency must be justified, verified to exist, maintained, license-compatible, exactly pinned and scanned. Allowed licenses: MIT, BSD, ISC, Apache-2.0, 0BSD, CC0; MPL-2.0 and LGPL only as unmodified libraries. GPL-3.0 and AGPL-3.0 need review; GPL-2.0-only, SSPL, BUSL, Elastic, non-commercial and unlicensed packages are blocked. Install scripts are disabled. Fix targets: critical 7 days, high 14, medium 30.

## AI-assisted code

Treat AI-generated code and suggested packages as untrusted until reviewed, tested and scanned. Check that every suggested package exists and is the intended one. Disclose significant AI assistance in the PR.

## Licensing of contributions

Code under AGPL-3.0-or-later; data, schemas and seed under CC0-1.0; docs under CC BY 4.0. New source files carry an `SPDX-License-Identifier` header.

## Versioning

SemVer 0.y.z while pre-1.0; annotated `vX.Y.Z` tags on `main`. See [docs/development.md](docs/development.md).

## Security

Never commit secrets or personal data. Report vulnerabilities privately ([SECURITY.md](SECURITY.md)).
