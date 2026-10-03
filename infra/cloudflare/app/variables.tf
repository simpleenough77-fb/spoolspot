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
  description = "us or eu. Immutable."
}
