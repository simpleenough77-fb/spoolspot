#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Points git at the repository hooks and checks the identity used for DCO sign-off.
set -eu
git config core.hooksPath .githooks
echo "git hooks installed (core.hooksPath=.githooks)"
if [ -z "$(git config user.name || true)" ] || [ -z "$(git config user.email || true)" ]; then
  echo "Set git user.name and user.email: commits are signed off with them (DCO)." >&2
fi
