# SPDX-License-Identifier: AGPL-3.0-or-later
variable "env" {
  type = string
  validation {
    condition     = contains(["stg", "prod"], var.env)
    error_message = "env must be stg or prod."
  }
}
variable "app_hostname" {
  type        = string
  description = "e.g. app.spoolspot.com (prod) or app.<nonprod-domain> (stg)"
}
variable "mail_domain" {
  type        = string
  description = "SES sending domain, e.g. mail.spoolspot.com"
}
