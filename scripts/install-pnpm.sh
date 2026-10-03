#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Installs the pnpm version pinned in package.json ("packageManager") with npm, after checking
# that the registry tarball's SHA-512 matches the hash pinned in the repository.
# Corepack 0.34 (bundled with Node 22 and 24) cannot run pnpm 12, so it is not used.
set -eu
pm="$(node -p "require('./package.json').packageManager")"
case "$pm" in
  pnpm@*+sha512.*) ;;
  *) echo "packageManager must look like pnpm@X.Y.Z+sha512.<hex>" >&2; exit 1 ;;
esac
version="${pm#pnpm@}"
version="${version%%+*}"
want_hex="${pm##*+sha512.}"
got_b64="$(npm view "pnpm@$version" dist.integrity)"
got_hex="$(printf '%s' "${got_b64#sha512-}" | base64 -d | od -An -v -tx1 | tr -d ' \n')"
if [ "$want_hex" != "$got_hex" ]; then
  echo "pnpm $version integrity mismatch: package.json pins $want_hex, registry has $got_hex" >&2
  exit 1
fi
npm install -g --ignore-scripts "pnpm@$version"
pnpm --version
