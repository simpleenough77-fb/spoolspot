## Ticket and docs

- Jira: SPOOL-<n> (the branch name, PR title and every commit carry the key)
- Confluence page: <link>

## What changed

## How it was tested

## Security criteria (ASVS L2)

- [ ] Acceptance criteria on the ticket were met; evidence linked here: <link>
- [ ] Input validated, output encoded, queries parameterised where touched
- [ ] No secrets, personal data or tokens in code, logs, URLs or tag payloads
- [ ] Tenant isolation enforced server-side and tested where records are touched

## Accessibility criteria (WCAG 2.2 AA)

- [ ] Automated check passes
- [ ] Manual checklist done for changed UI ([docs/accessibility-checklist.md](../docs/accessibility-checklist.md)), or no UI changed
- [ ] Every NFC flow touched has a non-NFC equivalent

## Dependencies added or changed

- [ ] None, or each is justified, verified to exist, maintained, license-compatible (ADR-0002) and pinned

## Review

- [ ] Owner review requested
- [ ] Generated code had an independent review pass (AI-generated code and suggested packages are untrusted until reviewed, tested and scanned)

## Public-safe

- [ ] No pricing, finances, security findings or sensitive runbook detail in this PR
- [ ] Commits are signed off (DCO, `git commit -s`)
