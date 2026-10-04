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

## State backend

One S3 bucket in the Shared account, SSE-KMS, versioned, native locking. One state key per stack and environment, so a bad apply in one stack cannot touch another. Always initialise through `scripts/tofu-init.sh`: it sets the key, passes `-reconfigure`, and refuses an AWS profile that does not match the stack.

| Stack             | Env               | State key                                 | AWS profile                                          |
| ----------------- | ----------------- | ----------------------------------------- | ---------------------------------------------------- |
| `bootstrap`       |                   | `bootstrap/terraform.tfstate`             | `ss-shared`                                          |
| `aws/shared`      |                   | `aws/shared/terraform.tfstate`            | `ss-shared`                                          |
| `aws/org`         |                   | `aws/org/terraform.tfstate`               | init uses `ss-shared`; plan and apply use `ss-payer` |
| `aws/identity`    | `stg`             | `aws/identity/stg/terraform.tfstate`      | `ss-id-nonprod`                                      |
| `aws/identity`    | `prod`            | `aws/identity/prod/terraform.tfstate`     | `ss-id-prod`                                         |
| `cloudflare/zone` | `prod`, `nonprod` | `cloudflare/zone/<env>/terraform.tfstate` | `ss-shared`                                          |
| `cloudflare/app`  | `stg`, `prod`     | `cloudflare/app/<env>/terraform.tfstate`  | `ss-shared`                                          |

Identity accounts reach the bucket through a role in the Shared account (SPOOL-173), not through bucket or key policy grants:

- `aws/shared` creates `ss-tfstate-identity-stg` and `ss-tfstate-identity-prod` (`tfstate-access.tf`). The backend assumes the role for its env.
- Trust: only the SpoolSpot-Admin SSO role of the matching identity account (name pattern pinned to the permission set and the 16-character hash), inside the organization.
- Permissions: read and write its own state object; read, write and delete its own `.tflock` object; list only its own prefix (and the empty workspace prefix); use the state key through S3 only. Nothing else.
- The bucket policy and the state KMS key policy (bootstrap) are unchanged.
- Backend files are gitignored: `envs/shared.backend.hcl` and `envs/identity-<env>.backend.hcl`. Copy them from the `.example` files. The state key is never in these files.

## Commands (human apply)

```
export CLOUDFLARE_API_TOKEN=...   # from the dashboard, expiry 24h, never in a file
AWS_PROFILE=ss-shared scripts/tofu-init.sh cloudflare/zone prod
cd infra/cloudflare/zone
tofu plan -var-file=../../envs/prod.auto.tfvars -out=tfplan   # review; see the first-plan rules below
../../../scripts/tofu-plan-check.sh tfplan 'cloudflare_dns_record.t_pi[0]' 'cloudflare_zone_dnssec.this'   # first plan only
tofu apply tfplan                 # never -auto-approve
```

`*.auto.tfvars` files load automatically only from the stack folder. `envs/prod.auto.tfvars` is outside it, so always pass `-var-file=../../envs/prod.auto.tfvars` (or copy the file into the stack folder; it stays gitignored either way).

First plan (SPOOL-170): run `scripts/dns-export.sh`, then in the gitignored tfvars set `t_record_id`, `import_dnssec = true` (DNSSEC is already active on the live zone) and, only if an `http_ratelimit` entrypoint ruleset already exists, `ratelimit_ruleset_id`. The import blocks in `main.tf` bring those live resources under management.

- The resolver record and DNSSEC must show **no change**. `prevent_destroy` does not stop an in-place update, so `scripts/tofu-plan-check.sh` (run from the stack folder) fails the check on any update, replace or create of those addresses. It checks only the addresses you name; read the rest of the plan yourself. Fix the variables to match the live resource; never apply a diff there.
- An imported rate-limit ruleset is a **reviewed update**: the rules in `main.tf` replace the live rules. Read that part of the plan line by line.
- Everything else is a create. Any other record the export lists needs its own import block first.
- Clear `t_record_id`, `import_dnssec` and `ratelimit_ruleset_id` after the first apply. `prevent_destroy` guards the resolver record and DNSSEC; removing it needs a separate, labelled PR.

Identity stacks: `AWS_PROFILE=ss-id-nonprod scripts/tofu-init.sh aws/identity stg`, then plan from `infra/aws/identity` with the same profile. Switching env means running the script again for the other env.

DNS hardening (SPOOL-171), zone stack:

- CAA: `issue` and `issuewild` allow only Cloudflare's Universal SSL CAs plus its backup CA (Let's Encrypt, Google Trust Services, SSL.com, Sectigo). Source: Cloudflare docs (SSL, certificate authorities and CAA records), checked 2026-10-04; the list is not exhaustive, so re-check before each apply. `issuewild` mirrors `issue` (without it, wildcard requests fall back to `issue` anyway, so it only makes the policy explicit). Cloudflare adds its own CAA records once any CAA exists; they do not show in the dashboard. After the first staging apply, run `dig CAA` and confirm there are no duplicate or rejected records.
- Email Routing and SPF: enable Email Routing first, then run `dig +short TXT <zone>` and set `spf_record_id` to the SPF record it created, so the record is imported. **Never apply with Email Routing enabled and `spf_record_id` unset**: that creates a second apex SPF record, which is an SPF permerror, and the Cloudflare API does not reject duplicates. The first plan shows an in-place update of that record (content moves to this file's SPF value, TTL moves to 3600); read it before approving. Email Routing's MX records are not managed here. Clear `spf_record_id` after the first apply.
- TXT quoting: the quoted TXT `content` form is unproven against the provider. In staging, after the first apply, a second plan must show no changes for the SPF, DMARC and bounce SPF records. If it shows a diff, fix the quoting before production.
- DMARC: the apex is `p=reject` on purpose (the apex never sends mail). If `dmarc_rua` is in another domain, the plan prints a warning: that domain must publish `<zone>._report._dmarc.<its domain>` TXT `"v=DMARC1"`.
- Phase 2 (resolver proxied by Cloudflare): the account-bound CAA on `t` governs any certificate issued for `t` itself (Advanced Certificate Manager, a Workers custom-domain certificate, Total TLS). The Universal certificate covers the wildcard and is validated at the apex, so it is not affected. Confirm which certificate serves `t` first. Set `acme_account_uri = null` (the plan then destroys that record) only if `t` gets its own certificate.

Identity stack inputs (SPOOL-172): copy `envs/identity.tfvars.example` to `infra/aws/identity/identity.auto.tfvars` (gitignored) and fill it for the env. `account_id` is passed to the provider as `allowed_account_ids`, so a run with the wrong account's credentials fails at plan. Check it by hand once: plan with the `ss-id-prod` profile and the stg `account_id`; it must fail before showing any resource. `zone_name` and `mail_subdomain` must equal the same variables in the `cloudflare/zone` stack for that env: the SES domain is `<mail_subdomain>.<zone_name>` and the MAIL FROM domain is `bounce.<that>`, whose MX and SPF records the zone stack creates. The pool has no tenant attribute on purpose: tenant and role live server-side, keyed by the Cognito `sub` (ADR-0004), and the app client can write the email attribute only. The SES identity has `prevent_destroy`, so changing `zone_name` or `mail_subdomain` (which forces a new identity) or tearing down an env fails at plan; removing the protection needs a separate, labelled PR. Cognito must not be given extra schema attributes: they cannot be removed or changed later.

## Local checks

`tofu fmt -check -recursive && tofu validate` in each stack (after `tofu init -backend=false`), `tofu test` in stacks that have a `tests/` folder (offline, mocked provider), then `checkov -d infra`.

## Rules baked in

`prevent_destroy` on buckets, D1 and the Cognito pool (remove only in a separate labelled PR). D1: no virtual tables (D8). Cognito app client is public PKCE (no secret in state). SSM parameters are created with placeholder values and `ignore_changes`; real values are set out of band.
