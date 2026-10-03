# GitHub settings as code

- `ruleset-main.json`: `main` requires a pull request (no required approvals while the project has one maintainer; resolved threads; rebase merge only; see the risk acceptance in the documentation space), a linear history and the single status check `ci-gate`; no deletion or force push; no bypass actors.
- `ruleset-tags.json`: `v*` tags cannot be deleted, moved or updated.
- `apply.sh`: applies these and the repository settings (merge methods, secret scanning and push protection, Dependabot alerts, private vulnerability reporting, read-only workflow token, SHA pinning required, allowed actions). Dry run by default; `--apply` executes. Requires an admin `gh` login.

Create the repository and the `ci-gate` check (by running CI once) before applying the ruleset. Settings that are not in the API (account MFA, Jira app) are in the development checklist.
