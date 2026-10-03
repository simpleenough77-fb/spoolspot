#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Applies the repository settings in infra/github with the gh CLI.
# Dry run by default (prints the commands); pass --apply to execute. Requires gh logged in as
# a repository admin. Re-running is safe: existing rulesets are skipped, settings are idempotent.
set -eu
REPO="${REPO:-simpleenough77-fb/spoolspot}"
dir="$(cd "$(dirname "$0")" && pwd)"
apply=0
[ "${1:-}" = "--apply" ] && apply=1

run() {
  if [ "$apply" -eq 1 ]; then
    echo "+ $*"
    "$@"
  else
    echo "[dry-run] $*"
  fi
}

# Merge policy: rebase only, delete merged branches, no wiki or projects.
run gh api -X PATCH "repos/$REPO" \
  -F allow_squash_merge=false -F allow_merge_commit=false -F allow_rebase_merge=true \
  -F delete_branch_on_merge=true -F has_wiki=false -F has_projects=false

# Secret scanning and push protection (free for public repositories).
run gh api -X PATCH "repos/$REPO" \
  -f 'security_and_analysis[secret_scanning][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'

# Dependabot alerts and security updates; private vulnerability reporting.
run gh api -X PUT "repos/$REPO/vulnerability-alerts"
run gh api -X PUT "repos/$REPO/automated-security-fixes"
run gh api -X PUT "repos/$REPO/private-vulnerability-reporting"

# Actions: read-only default token, no PR approval by workflows, SHA pinning required,
# only GitHub-owned actions plus the two third-party actions the workflows use.
run gh api -X PUT "repos/$REPO/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
run gh api -X PUT "repos/$REPO/actions/permissions" \
  -F enabled=true -f allowed_actions=selected -F sha_pinning_required=true
run gh api -X PUT "repos/$REPO/actions/permissions/selected-actions" \
  -F github_owned_allowed=true -F verified_allowed=false \
  -f 'patterns_allowed[]=anchore/sbom-action@*' -f 'patterns_allowed[]=zizmorcore/zizmor-action@*'

# Rulesets (skipped if one with the same name exists).
for f in ruleset-main.json ruleset-tags.json; do
  name="$(sed -n 's/^  "name": "\(.*\)",$/\1/p' "$dir/$f")"
  if [ "$apply" -eq 1 ] && gh api "repos/$REPO/rulesets" --jq '.[].name' | grep -Fxq "$name"; then
    echo "ruleset exists, skipped: $name"
  else
    run gh api -X POST "repos/$REPO/rulesets" --input "$dir/$f"
  fi
done
echo "Done. Verify with: gh api repos/$REPO/rulesets --jq '.[].name'"
