#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Initialise one OpenTofu stack with the one state key it owns (SPOOL-173). Human use, from the maintainer's workstation.
# Sets the key, always passes -reconfigure, and refuses an AWS profile that does not match the stack.
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: AWS_PROFILE=<profile> scripts/tofu-init.sh <stack> [env]
  bootstrap                        AWS_PROFILE=ss-shared
  aws/shared                       AWS_PROFILE=ss-shared
  aws/org                          backend uses profile ss-shared; plan and apply with AWS_PROFILE=ss-payer
  aws/identity stg|prod            AWS_PROFILE=ss-id-nonprod (stg) or ss-id-prod (prod)
  cloudflare/zone prod|nonprod     AWS_PROFILE=ss-shared
  cloudflare/app stg|prod          AWS_PROFILE=ss-shared
USAGE
  exit 2
}

[[ $# -ge 1 && $# -le 2 ]] || usage
stack="$1"
env="${2:-}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
backend_file="${root}/infra/envs/shared.backend.hcl"
need_profile=""
extra=()

case "${stack}" in
  bootstrap | aws/shared)
    [[ -z "${env}" ]] || usage
    key="${stack}/terraform.tfstate"
    need_profile="ss-shared"
    ;;
  aws/org)
    [[ -z "${env}" ]] || usage
    key="aws/org/terraform.tfstate"
    extra=("-backend-config=profile=ss-shared")
    ;;
  aws/identity)
    case "${env}" in
      stg) need_profile="ss-id-nonprod" ;;
      prod) need_profile="ss-id-prod" ;;
      *) usage ;;
    esac
    key="aws/identity/${env}/terraform.tfstate"
    backend_file="${root}/infra/envs/identity-${env}.backend.hcl"
    ;;
  cloudflare/zone)
    case "${env}" in prod | nonprod) ;; *) usage ;; esac
    key="cloudflare/zone/${env}/terraform.tfstate"
    need_profile="ss-shared"
    ;;
  cloudflare/app)
    case "${env}" in stg | prod) ;; *) usage ;; esac
    key="cloudflare/app/${env}/terraform.tfstate"
    need_profile="ss-shared"
    ;;
  *) usage ;;
esac

if [[ -n "${need_profile}" && "${AWS_PROFILE:-}" != "${need_profile}" ]]; then
  echo "error: ${stack} ${env} needs AWS_PROFILE=${need_profile} (got '${AWS_PROFILE:-unset}')." >&2
  echo "Prefix inline: AWS_PROFILE=${need_profile} scripts/tofu-init.sh ${stack} ${env}" >&2
  exit 1
fi

# Static credentials in the environment can override the profile; refuse them so the profile check means something.
if [[ -n "${AWS_ACCESS_KEY_ID:-}${AWS_SECRET_ACCESS_KEY:-}${AWS_SESSION_TOKEN:-}" ]]; then
  echo "error: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY or AWS_SESSION_TOKEN is set. Unset them and use the SSO profile." >&2
  exit 1
fi

if [[ ! -f "${backend_file}" ]]; then
  echo "error: missing ${backend_file#"${root}"/} (gitignored). Copy it from its .example file in infra/envs/." >&2
  exit 1
fi

# An identity backend file must set assume_role to the role of its own env (catches a stg file copied to prod).
# IAM trust is the real control; this is a typo guard.
if [[ "${stack}" == "aws/identity" ]] && ! grep -Eq "^[[:space:]]*assume_role[[:space:]]*=.*role/ss-tfstate-identity-${env}\"" "${backend_file}"; then
  echo "error: ${backend_file#"${root}"/} does not assume role ss-tfstate-identity-${env}." >&2
  exit 1
fi

tofu_bin="${TOFU:-tofu}" # TOFU: path override, also used as a test hook
echo "init ${stack}${env:+ (${env})}: state key ${key}"
cd "${root}/infra/${stack}"
"${tofu_bin}" init -reconfigure -input=false -lockfile=readonly \
  -backend-config="${backend_file}" -backend-config="key=${key}" ${extra[@]+"${extra[@]}"}

# -reconfigure never migrates state. These three stacks are already applied, so an empty state here means the key is wrong.
case "${stack}" in
  bootstrap | aws/shared | aws/org)
    if [[ -z "$("${tofu_bin}" state list)" ]]; then
      echo "error: state at ${key} is empty but ${stack} is already applied. Do NOT plan or apply. Check the key and the backend file." >&2
      exit 1
    fi
    ;;
esac
