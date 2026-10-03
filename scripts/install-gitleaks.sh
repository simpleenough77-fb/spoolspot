#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Installs gitleaks v8.30.1 into .tools/bin with a pinned SHA-256 check (macOS and Linux).
set -eu
version="8.30.1"
os="$(uname -s)"
arch="$(uname -m)"
case "$os-$arch" in
  Linux-x86_64) asset="linux_x64"; sum="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb" ;;
  Linux-aarch64 | Linux-arm64) asset="linux_arm64"; sum="e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080" ;;
  Darwin-arm64) asset="darwin_arm64"; sum="b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5" ;;
  Darwin-x86_64) asset="darwin_x64"; sum="dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709" ;;
  *) echo "Unsupported platform $os-$arch. Install gitleaks $version manually." >&2; exit 1 ;;
esac
root="$(git rev-parse --show-toplevel)"
dest="$root/.tools/bin"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$dest"
curl -fsSL -o "$tmp/gl.tgz" \
  "https://github.com/gitleaks/gitleaks/releases/download/v$version/gitleaks_${version}_${asset}.tar.gz"
if command -v sha256sum >/dev/null 2>&1; then
  echo "$sum  $tmp/gl.tgz" | sha256sum -c -
else
  echo "$sum  $tmp/gl.tgz" | shasum -a 256 -c -
fi
tar -xzf "$tmp/gl.tgz" -C "$tmp" gitleaks
install -m 0755 "$tmp/gitleaks" "$dest/gitleaks"
"$dest/gitleaks" version
