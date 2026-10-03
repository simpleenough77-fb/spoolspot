# SPDX-License-Identifier: AGPL-3.0-or-later
# Every existing record MUST be imported first (scripts/dns-export.sh, plan section 5). The first plan must show zero changes.

# ---------- DNSSEC ----------
resource "cloudflare_zone_dnssec" "this" {
  zone_id = var.zone_id
  status  = "active" # Cloudflare Registrar adds the DS record itself [V]; verify with dig +short DS
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
  ttl     = 300
  proxied = false
  comment = "ADR-0001 phase 1; repointed to the Worker in phase 2 (gate G8)"
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
