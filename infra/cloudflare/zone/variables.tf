# SPDX-License-Identifier: AGPL-3.0-or-later
variable "zone_id" {
  type        = string
  description = "Zone ID (kept out of the repo)"
  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.zone_id))
    error_message = "zone_id must be 32 lowercase hex characters."
  }
}
variable "zone_name" {
  type    = string
  default = "spoolspot.com"
}
variable "pi_private_ip" {
  type        = string
  description = "RFC1918 address of the Pi serving t. in phase 1 (kept out of the repo)"
  default     = null
  validation {
    condition = var.pi_private_ip == null ? true : (
      can(regex("^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$", var.pi_private_ip)) &&
      try(anytrue([for c in ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"] : cidrcontains(c, var.pi_private_ip)]), false)
    )
    error_message = "pi_private_ip must be a plain dotted-quad IPv4 address (no leading zeros) in 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16."
  }
}
variable "acme_delegation_target" {
  type        = string
  description = "FQDN in the separate low-value ACME zone that _acme-challenge.t CNAMEs to (ADR-0001)"
  default     = null
}
variable "acme_account_uri" {
  type        = string
  description = "Let's Encrypt ACME account URI used by the Pi, for the accounturi CAA parameter"
  default     = null
}
variable "caa_issuers" {
  type        = list(string)
  description = "CA domains allowed to issue for the apex (CAA issue and issuewild). Cloudflare Universal SSL uses Let's Encrypt, Google Trust Services and SSL.com; Sectigo is its backup CA. Source: Cloudflare docs, SSL > Reference > Certificate authorities and Edge certificates > CAA records, checked 2026-10-04. DigiCert is not on the list and is not allowed. The list is not exhaustive and Cloudflare may change it, so re-check before each apply."
  default     = ["letsencrypt.org", "pki.goog", "ssl.com", "sectigo.com"]
  validation {
    condition     = length(var.caa_issuers) > 0 && alltrue([for c in var.caa_issuers : can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", c))])
    error_message = "caa_issuers must list at least one CA, each a plain lowercase domain such as letsencrypt.org (no parameters, quotes or semicolons)."
  }
}
variable "security_mailbox" {
  type        = string
  default     = "security@spoolspot.com"
  description = "iodef contact"
}
variable "dmarc_rua" {
  type        = string
  description = "mailto: address you actually read for DMARC aggregate reports"
  validation {
    condition     = can(regex("^mailto:[^\\s\";\\\\@]+@[^\\s\";\\\\@]+$", var.dmarc_rua)) && length(var.dmarc_rua) <= 200
    error_message = "dmarc_rua must be mailto:<name>@<domain> (200 characters at most), with no spaces, quotes, semicolons or backslashes."
  }
}
variable "mail_subdomain" {
  type    = string
  default = "mail"
}
variable "ses_dkim_tokens" {
  type    = list(string)
  default = [] # filled from aws/identity output at Phase B/C
}
variable "ses_mail_from_region" {
  type    = string
  default = "us-east-1"
}
variable "hsts_max_age" {
  type        = number
  default     = 86400 # ramp: 1 day -> 1 week -> 1 month -> 6 months; no preload
  description = "HSTS max-age seconds"
}
variable "resolver_host" {
  type    = string
  default = "t.spoolspot.com"
  validation {
    condition = (
      length(var.resolver_host) <= 253 &&
      endswith(var.resolver_host, ".${var.zone_name}") &&
      can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$", var.resolver_host))
    )
    error_message = "resolver_host must be a lowercase hostname inside zone_name (end with .<zone_name>, no empty labels)."
  }
}
variable "t_record_id" {
  type        = string
  default     = null
  description = "ID of the live resolver A record, for the first-plan import (kept out of the repo). Set only while importing; needs pi_private_ip."
  validation {
    condition     = var.t_record_id == null ? true : can(regex("^[0-9a-f]{32}$", var.t_record_id))
    error_message = "t_record_id must be 32 lowercase hex characters."
  }
  validation {
    condition     = var.t_record_id == null ? true : var.pi_private_ip != null
    error_message = "t_record_id imports the resolver A record, which is only managed when pi_private_ip is set."
  }
}
variable "ratelimit_ruleset_id" {
  type        = string
  default     = null
  description = "ID of an existing http_ratelimit entrypoint ruleset in the zone, for the first-plan import (kept out of the repo). Leave null if none exists."
  validation {
    condition     = var.ratelimit_ruleset_id == null ? true : can(regex("^[0-9a-f]{32}$", var.ratelimit_ruleset_id))
    error_message = "ratelimit_ruleset_id must be 32 lowercase hex characters."
  }
}
variable "import_dnssec" {
  type        = bool
  default     = false
  description = "First plan only: import the already-active DNSSEC setting instead of enabling it. Clear after the first apply."
}
variable "spf_record_id" {
  type        = string
  default     = null
  description = "ID of the apex SPF TXT record that Email Routing created, for the first-plan import (kept out of the repo). Set only while importing."
  validation {
    condition     = var.spf_record_id == null ? true : can(regex("^[0-9a-f]{32}$", var.spf_record_id))
    error_message = "spf_record_id must be 32 lowercase hex characters."
  }
}
variable "manage_ses_records" {
  type    = bool
  default = false
}
