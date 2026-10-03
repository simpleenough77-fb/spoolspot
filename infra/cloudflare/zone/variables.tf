# SPDX-License-Identifier: AGPL-3.0-or-later
variable "zone_id" {
  type        = string
  description = "Zone ID (kept out of the repo)"
}
variable "zone_name" {
  type    = string
  default = "spoolspot.com"
}
variable "pi_private_ip" {
  type        = string
  description = "RFC1918 address of the Pi serving t. in phase 1 (kept out of the repo)"
  default     = null
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
  description = "CAs allowed for the apex. Must include Cloudflare Universal SSL partner CAs. [U] confirm the list against Cloudflare's CA reference before apply."
  default     = ["letsencrypt.org", "pki.goog", "ssl.com", "digicert.com", "sectigo.com"]
}
variable "security_mailbox" {
  type        = string
  default     = "security@spoolspot.com"
  description = "iodef contact"
}
variable "dmarc_rua" {
  type        = string
  description = "mailto: address you actually read for DMARC aggregate reports"
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
}
variable "manage_ses_records" {
  type    = bool
  default = false
}
