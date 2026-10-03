#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# prepare-commit-msg hook: add a DCO "Signed-off-by" trailer for the configured git identity.
# Skips merge and squash commits.
set -eu
msg_file="$1"
source="${2:-}"
case "$source" in merge | squash) exit 0 ;; esac
name="$(git config user.name || true)"
email="$(git config user.email || true)"
if [ -z "$name" ] || [ -z "$email" ]; then
  echo "git user.name and user.email must be set to sign off commits." >&2
  exit 1
fi
git interpret-trailers --in-place --if-exists addIfDifferent \
  --trailer "Signed-off-by: $name <$email>" "$msg_file"
