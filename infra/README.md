# infra

- `ci/`: hash-pinned Python requirements for CI tools (Checkov).
- `github/`: repository rulesets and the script that applies GitHub settings.
- `bootstrap/`, `aws/`, `cloudflare/`, `envs/`: cloud infrastructure as code (OpenTofu), added under SPOOL-18. Details below.

Public repo: **no account IDs, zone IDs, private addresses, secrets or the non-production domain name** in tracked files. They live in gitignored `*.auto.tfvars`, `envs/*.backend.hcl`, and GitHub Environment variables.

STATUS: bootstrap, aws/shared and aws/org are applied (2026-10-03). aws/identity and cloudflare/* are drafts and not applied. Every apply needs the maintainer's explicit approval.

## Stacks and who applies

| Stack                                                    | Account                                         | Applied by                                                                 |
| -------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| `bootstrap`                                              | shared account                                  | Avi, workstation, SSO, once                                                |
| `aws/org`                                                | management account (SpoolSpot-Payer)            | Avi, workstation, SSO                                                      |
| `aws/shared`                                             | shared account                                  | CI (`aws-apply` environment, reviewer required) after the first manual run |
| `aws/identity` (env stg, prod)                           | identity-nonprod account, identity-prod account | CI as above                                                                |
| `cloudflare/zone` (prod zone)                            | prod Cloudflare account                         | Avi, workstation, 24-hour token                                            |
| `cloudflare/zone` (nonprod zone), `cloudflare/app` (stg) | nonprod Cloudflare account                      | CI with the stg token under ADR-0012                                       |
| `cloudflare/app` (prod)                                  | prod Cloudflare account                         | Avi, workstation, 24-hour token                                            |

## Cloudflare token scopes (account API token, expiry 24 h for prod)

- zone stack: Zone Read, DNS Edit, Zone Settings Edit, DNSSEC Edit, Zone WAF/Rulesets Edit (Email Routing Edit if rules are managed). Restrict to the single zone.
- app stack: D1 Edit (and Workers Scripts Edit once the Worker shell is added). Account-scoped.
- drift and export read tokens: see plan section 9. [U] minimum D1 export scope to be proven in staging.

## Commands (human apply)

```
export CLOUDFLARE_API_TOKEN=...   # from the dashboard, expiry 24h, never in a file
cd infra/cloudflare/zone
tofu init -backend-config=../../envs/shared.backend.hcl
tofu plan -out=tfplan             # review; first run after import must show ZERO changes
tofu apply tfplan                 # never -auto-approve
```

Before the first plan: `scripts/dns-export.sh`, then `tofu import` every existing record.

## Local checks

`tofu fmt -check -recursive && tofu validate` in each stack (after `tofu init -backend=false`), then `checkov -d infra`.

## Rules baked in

`prevent_destroy` on buckets, D1 and the Cognito pool (remove only in a separate labelled PR). D1: no virtual tables (D8). Cognito app client is public PKCE (no secret in state). SSM parameters are created with placeholder values and `ignore_changes`; real values are set out of band.
