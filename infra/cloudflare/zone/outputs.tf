# SPDX-License-Identifier: AGPL-3.0-or-later
output "dnssec_status" { value = cloudflare_zone_dnssec.this.status }
