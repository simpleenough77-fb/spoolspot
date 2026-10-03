#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Read-only zone snapshot. Needs CLOUDFLARE_API_TOKEN (DNS Read) and ZONE_ID in the environment. Never commit output.
set -euo pipefail
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (read-only DNS token)}"
: "${ZONE_ID:?set ZONE_ID}"
out="${1:-dns-export-$(date -u +%Y%m%dT%H%M%SZ).bind}"
curl -fsS -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/export" -o "${out}"
chmod 600 "${out}"
echo "wrote ${out} ($(wc -l < "${out}") lines)"
