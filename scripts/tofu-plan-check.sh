#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Fail unless every named resource address is a NO-OP in a saved OpenTofu plan (SPOOL-170).
# prevent_destroy does not stop an in-place update, so a live imported resource that must not change is checked here.
# usage (run from the stack folder): scripts/tofu-plan-check.sh <planfile> <address>...
# It checks only the addresses you name; read the rest of the plan yourself.
# example: scripts/tofu-plan-check.sh tfplan 'cloudflare_dns_record.t_pi[0]' 'cloudflare_zone_dnssec.this'
set -euo pipefail
[[ $# -ge 2 ]] || { echo "usage: $0 <planfile> <address>..." >&2; exit 2; }
plan="$1"
[[ "${plan}" != -* ]] || { echo "error: plan file must not start with a dash" >&2; exit 2; }
shift
command -v python3 > /dev/null || { echo "error: python3 is required" >&2; exit 2; }
"${TOFU:-tofu}" show -json "${plan}" | python3 -c '
import json, sys
want = sys.argv[1:]
changes = {c["address"]: c for c in json.load(sys.stdin).get("resource_changes", [])}
bad = 0
for addr in want:
    c = changes.get(addr)
    if c is None:
        print(f"FAIL {addr}: not in the plan (wrong address, or the resource is not managed)")
        bad += 1
        continue
    actions = c["change"]["actions"]
    if actions != ["no-op"]:
        print(f"FAIL {addr}: planned {actions}, expected no-op. Fix the variables to match the live resource; do not apply.")
        bad += 1
    else:
        print(f"ok   {addr}: no-op")
sys.exit(1 if bad else 0)
' "$@"
