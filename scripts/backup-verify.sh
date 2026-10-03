#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Verify a D1 SQL export by loading it into a scratch SQLite DB and running integrity checks.
set -euo pipefail
f="${1:?usage: backup-verify.sh export.sql[.gz]}"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
case "$f" in *.gz) gunzip -c "$f" > "$tmp/in.sql" ;; *) cp "$f" "$tmp/in.sql" ;; esac
sqlite3 "$tmp/db.sqlite" < "$tmp/in.sql"
[ "$(sqlite3 "$tmp/db.sqlite" 'PRAGMA integrity_check;')" = "ok" ] || { echo "integrity_check FAILED"; exit 1; }
fk="$(sqlite3 "$tmp/db.sqlite" 'PRAGMA foreign_key_check;')"
[ -z "$fk" ] || { echo "foreign_key_check FAILED: $fk"; exit 1; }
echo "tables:"; sqlite3 "$tmp/db.sqlite" "select name from sqlite_master where type='table' order by 1;" | while read -r t; do printf '  %s: ' "$t"; sqlite3 "$tmp/db.sqlite" "select count(*) from \"$t\";"; done
echo "OK"
