# SPDX-License-Identifier: AGPL-3.0-or-later
variable "account_id" {
  type        = string
  description = "Cloudflare account ID (kept out of the repo)"
}
variable "env" {
  type = string
  validation {
    condition     = contains(["stg", "prod"], var.env)
    error_message = "env must be stg or prod."
  }
}
variable "d1_jurisdiction" {
  type        = string
  default     = "us" # D10: can only be set at creation [V]; changing it means a new database
  description = "eu, us or fedramp. Immutable. Provider 5.27 accepts all three (schema and plan, checked 2026-10-04); acceptance by the Cloudflare API for us is [U] until the first apply."
  validation {
    condition     = contains(["eu", "us", "fedramp"], var.d1_jurisdiction)
    error_message = "d1_jurisdiction must be eu, us or fedramp."
  }
}
