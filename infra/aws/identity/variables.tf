# SPDX-License-Identifier: AGPL-3.0-or-later
variable "env" {
  type = string
  validation {
    condition     = contains(["stg", "prod"], var.env)
    error_message = "env must be stg or prod."
  }
}
variable "account_id" {
  type        = string
  description = "12-digit ID of the identity account this env must run in (identity-nonprod for stg, identity-prod for prod). Kept in gitignored tfvars. The provider refuses to run against any other account."
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be exactly 12 digits."
  }
}
variable "zone_name" {
  type        = string
  description = "DNS zone for this env, the same value as zone_name in the cloudflare/zone stack (spoolspot.com for prod, the nonprod domain for stg)"
  validation {
    condition = (
      can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.zone_name)) &&
      !can(regex("^[0-9.]+$", var.zone_name)) &&
      length(var.zone_name) <= 190
    )
    error_message = "zone_name must be a lowercase domain name such as example.com (not an IP address, at most 190 characters)."
  }
}
variable "mail_subdomain" {
  type        = string
  default     = "mail"
  description = "Sending subdomain, the same value as mail_subdomain in the cloudflare/zone stack. The SES domain is <mail_subdomain>.<zone_name>; the bounce MAIL FROM domain is bounce.<that>."
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$", var.mail_subdomain))
    error_message = "mail_subdomain must be a single lowercase DNS label."
  }
}
variable "app_hostname" {
  type        = string
  description = "e.g. app.spoolspot.com (prod) or app.<nonprod-domain> (stg). Must sit inside zone_name."
  validation {
    condition = (
      endswith(var.app_hostname, ".${var.zone_name}") &&
      can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.app_hostname))
    )
    error_message = "app_hostname must be a plain lowercase hostname inside zone_name (end with .<zone_name>; no slashes, ports or other characters). It becomes the OAuth callback host and the passkey relying-party ID."
  }
}
