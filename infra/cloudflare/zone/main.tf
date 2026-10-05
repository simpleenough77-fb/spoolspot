# SPDX-License-Identifier: AGPL-3.0-or-later
# SPOOL-170. First plan expectations (live resources are imported, never recreated):
#   - The resolver A record (t_pi) and, if import_dnssec is true, cloudflare_zone_dnssec.this MUST show NO CHANGE.
#     Run scripts/tofu-plan-check.sh on the saved plan: it fails on any update, replace or create of those addresses.
#     A diff on t_pi means the variables do not match the live record: fix the variables, never apply the diff.
#   - An imported http_ratelimit entrypoint ruleset is a REVIEWED UPDATE: the rules in this file replace the live rules.
#     Read that part of the plan line by line before approving.
#   - Every other resource in this stack is a CREATE on the first plan.
#   - Run scripts/dns-export.sh first. Any other record the export lists must be imported too (add an import block)
#     before apply, or the apply creates a duplicate or fails.
# Clear t_record_id, ratelimit_ruleset_id and import_dnssec from the gitignored tfvars after the first apply.
# prevent_destroy blocks destroy and replace. It does NOT block an in-place update, hence the plan check above.

# ---------- Import of live resources (IDs come from gitignored tfvars, never from this file) ----------
import {
  for_each = var.t_record_id == null ? toset([]) : toset([var.t_record_id])
  to       = cloudflare_dns_record.t_pi[0]
  id       = "${var.zone_id}/${each.value}"
}
# A zone has ONE entrypoint ruleset per phase. If http_ratelimit already has one, creating a second fails or
# overwrites it: import it, and read the plan, because the rules in this file replace the rules that exist.
import {
  for_each = var.ratelimit_ruleset_id == null ? toset([]) : toset([var.ratelimit_ruleset_id])
  to       = cloudflare_ruleset.rate_limit_resolver
  id       = "zones/${var.zone_id}/${each.value}"
}
# DNSSEC is already active on the live zone. Import it so the apply does not try to enable it again (import ID = zone ID, provider 5.27.0 docs).
import {
  for_each = var.import_dnssec ? toset([var.zone_id]) : toset([])
  to       = cloudflare_zone_dnssec.this
  id       = each.value
}

# Enabling Email Routing creates its own apex SPF TXT record. Order: enable Email Routing, then set spf_record_id so it is
# IMPORTED here (never created a second time), then read the plan: the content moves to the SPF value in this file, a
# reviewed update. A zone must have exactly one SPF record at the apex.
import {
  for_each = var.spf_record_id == null ? toset([]) : toset([var.spf_record_id])
  to       = cloudflare_dns_record.spf_apex
  id       = "${var.zone_id}/${each.value}"
}

# ---------- DNSSEC ----------
resource "cloudflare_zone_dnssec" "this" {
  zone_id = var.zone_id
  status  = "active" # Cloudflare Registrar adds the DS record itself [V]; verify with dig +short DS
  # Removing this needs a separate, labelled PR, and for the account move follows the DNSSEC steps in the DNS and domain plan.
  lifecycle { prevent_destroy = true }
}

# ---------- CAA ----------
resource "cloudflare_dns_record" "caa_issue" {
  for_each = toset(var.caa_issuers)
  zone_id  = var.zone_id
  name     = var.zone_name
  type     = "CAA"
  ttl      = 3600
  data = {
    flags = 0
    tag   = "issue"
    value = each.value
  }
}
# issuewild mirrors issue. With no issuewild record, wildcard requests fall back to issue (RFC 8659), so this changes no
# permission: it makes the wildcard policy explicit and stops a later issue-only edit from silently widening it.
# Cloudflare also adds its own CAA records once any CAA exists (hidden in the dashboard; check with dig CAA after the
# first staging apply, in case the API treats an identical record as a duplicate).
resource "cloudflare_dns_record" "caa_issuewild" {
  for_each = toset(var.caa_issuers)
  zone_id  = var.zone_id
  name     = var.zone_name
  type     = "CAA"
  ttl      = 3600
  data = {
    flags = 0
    tag   = "issuewild"
    value = each.value
  }
}
resource "cloudflare_dns_record" "caa_iodef" {
  zone_id = var.zone_id
  name    = var.zone_name
  type    = "CAA"
  ttl     = 3600
  data = {
    flags = 0
    tag   = "iodef"
    value = "mailto:${var.security_mailbox}"
  }
}
# Bind the Pi's certificate to your ACME account, DNS-01 only (even a stolen DNS token cannot get a cert).
# PHASE 2 (t proxied by Cloudflare): the closest CAA wins, so this record governs any certificate issued for t itself
# (Advanced Certificate Manager, a Workers custom-domain certificate, Total TLS). The Universal certificate covers
# *.<zone> and is validated against the apex, so it is NOT affected. Before phase 2, confirm which certificate serves t;
# set acme_account_uri to null (the plan destroys this record) only if t gets its own certificate.
resource "cloudflare_dns_record" "caa_t_accounturi" {
  count   = var.acme_account_uri == null ? 0 : 1
  zone_id = var.zone_id
  name    = var.resolver_host
  type    = "CAA"
  ttl     = 3600
  data = {
    flags = 0
    tag   = "issue"
    value = "letsencrypt.org; accounturi=${var.acme_account_uri}; validationmethods=dns-01"
  }
}

# ---------- Resolver host, phase 1: DNS-only A to the Pi ----------
resource "cloudflare_dns_record" "t_pi" {
  count   = var.pi_private_ip == null ? 0 : 1
  zone_id = var.zone_id
  name    = var.resolver_host
  type    = "A"
  content = var.pi_private_ip
  # Matches the LIVE record (SPOOL-170 first plan, 2026-10-05): TTL Auto (1) and no comment. Changing either is a separate,
  # reviewed update after the zero-diff import. The TTL is lowered before the account move (DNS plan, step 4).
  ttl     = 1
  proxied = false
  # Every NFC tag resolves through this record. Removing the protection needs a separate, labelled PR.
  lifecycle { prevent_destroy = true }
}
resource "cloudflare_dns_record" "acme_delegation" {
  count   = var.acme_delegation_target == null ? 0 : 1
  zone_id = var.zone_id
  name    = "_acme-challenge.${var.resolver_host}"
  type    = "CNAME"
  content = var.acme_delegation_target
  ttl     = 300
  proxied = false
}

# ---------- Mail: apex never sends; inbound through Email Routing ----------
resource "cloudflare_dns_record" "spf_apex" {
  zone_id = var.zone_id
  name    = var.zone_name
  type    = "TXT"
  content = "\"v=spf1 include:_spf.mx.cloudflare.net -all\"" # [U] include needed for Email Routing forwarding
  ttl     = 3600
}
# DELIBERATE DEVIATION from the p=none-first baseline: the apex never sends mail (SPF -all), so p=reject cannot cause a
# false rejection of our own mail. The sending subdomain starts at p=none (dmarc_mail below).
resource "cloudflare_dns_record" "dmarc" {
  zone_id = var.zone_id
  name    = "_dmarc.${var.zone_name}"
  type    = "TXT"
  content = "\"v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s; rua=${var.dmarc_rua}\""
  ttl     = 3600
}
# Email Routing MX/rules are created by enabling Email Routing; import them, do not duplicate. [U]

# ---------- SES (Phase B/C, off until tokens exist) ----------
resource "cloudflare_dns_record" "ses_dkim" {
  count   = var.manage_ses_records ? length(var.ses_dkim_tokens) : 0
  zone_id = var.zone_id
  name    = "${var.ses_dkim_tokens[count.index]}._domainkey.${var.mail_subdomain}.${var.zone_name}"
  type    = "CNAME"
  content = "${var.ses_dkim_tokens[count.index]}.dkim.amazonses.com"
  ttl     = 3600
  proxied = false
}
resource "cloudflare_dns_record" "ses_mailfrom_mx" {
  count    = var.manage_ses_records ? 1 : 0
  zone_id  = var.zone_id
  name     = "bounce.${var.mail_subdomain}.${var.zone_name}"
  type     = "MX"
  content  = "feedback-smtp.${var.ses_mail_from_region}.amazonses.com"
  priority = 10
  ttl      = 3600
}
resource "cloudflare_dns_record" "ses_mailfrom_spf" {
  count   = var.manage_ses_records ? 1 : 0
  zone_id = var.zone_id
  name    = "bounce.${var.mail_subdomain}.${var.zone_name}"
  type    = "TXT"
  content = "\"v=spf1 include:amazonses.com -all\""
  ttl     = 3600
}
resource "cloudflare_dns_record" "dmarc_mail" {
  count   = var.manage_ses_records ? 1 : 0
  zone_id = var.zone_id
  name    = "_dmarc.${var.mail_subdomain}.${var.zone_name}"
  type    = "TXT"
  content = "\"v=DMARC1; p=none; rua=${var.dmarc_rua}\"" # raise to reject after two clean weeks
  ttl     = 3600
}

# DMARC reports sent to a mailbox in another organizational domain are only delivered if that domain publishes
# <zone>._report._dmarc.<its domain> TXT "v=DMARC1" (RFC 7489 section 7.1). This warns, it does not fail the plan.
check "dmarc_rua_authorization" {
  assert {
    condition     = endswith(lower(var.dmarc_rua), "@${var.zone_name}") || endswith(lower(var.dmarc_rua), ".${var.zone_name}")
    error_message = "dmarc_rua is in another domain: that domain must publish ${var.zone_name}._report._dmarc.<its domain> TXT \"v=DMARC1\" or aggregate reports may be dropped."
  }
}

# ---------- TLS and edge settings ----------
resource "cloudflare_zone_setting" "min_tls" {
  zone_id    = var.zone_id
  setting_id = "min_tls_version"
  value      = "1.2"
}
resource "cloudflare_zone_setting" "tls13" {
  zone_id    = var.zone_id
  setting_id = "tls_1_3"
  value      = "on"
}
resource "cloudflare_zone_setting" "always_https" {
  zone_id    = var.zone_id
  setting_id = "always_use_https"
  value      = "on"
}
resource "cloudflare_zone_setting" "https_rewrites" {
  zone_id    = var.zone_id
  setting_id = "automatic_https_rewrites"
  value      = "off"
}
resource "cloudflare_zone_setting" "ssl_mode" {
  zone_id    = var.zone_id
  setting_id = "ssl"
  value      = "strict"
}
resource "cloudflare_zone_setting" "hsts" {
  zone_id    = var.zone_id
  setting_id = "security_header"
  value = {
    strict_transport_security = {
      enabled            = true
      max_age            = var.hsts_max_age
      include_subdomains = false # raise only after every subdomain is verified HTTPS
      preload            = false # hard to undo; Avi decides later
      nosniff            = true
    }
  }
}

# ---------- Rate limit on the resolver (Free plan: one rule, 10 s window) ----------
resource "cloudflare_ruleset" "rate_limit_resolver" {
  zone_id     = var.zone_id
  name        = "ss-rate-limit-resolver"
  description = "Limit unauthenticated tag resolver abuse before it reaches a Worker"
  kind        = "zone"
  phase       = "http_ratelimit"
  rules = [{
    action      = "block"
    description = "resolver per-IP limit"
    expression  = "(http.host eq \"${var.resolver_host}\")"
    enabled     = true
    ratelimit = {
      characteristics     = ["cf.colo.id", "ip.src"]
      period              = 10
      requests_per_period = 30
      mitigation_timeout  = 10
    } # [U] exact values and characteristics allowed on Free; note the host is DNS-only until phase 2, so this applies only once proxied
  }]
}
