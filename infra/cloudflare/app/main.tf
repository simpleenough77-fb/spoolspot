# SPDX-License-Identifier: AGPL-3.0-or-later
# D1 only at this checkpoint. Worker shell and custom domains wait for the Worker code and a staging prototype ([U], plan section 4).
# D8: no FTS5 / virtual tables in any migration (D1 export cannot handle them).

resource "cloudflare_d1_database" "db" {
  account_id       = var.account_id
  name             = "ss-${var.env}-db"
  jurisdiction     = var.d1_jurisdiction
  read_replication = { mode = "disabled" }
  lifecycle { prevent_destroy = true }
}

resource "cloudflare_d1_database" "registry" {
  account_id       = var.account_id
  name             = "ss-${var.env}-registry"
  jurisdiction     = var.d1_jurisdiction
  read_replication = { mode = "disabled" }
  lifecycle { prevent_destroy = true }
}
