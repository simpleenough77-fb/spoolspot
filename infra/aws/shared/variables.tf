# SPDX-License-Identifier: AGPL-3.0-or-later
variable "github_repo" {
  type        = string
  description = "owner/repo, e.g. avivi/spoolspot"
}
variable "oidc_provider_arn" {
  sensitive   = true
  type        = string
  description = "From bootstrap output"
}
variable "org_id" {
  sensitive   = true
  type        = string
  description = "AWS Organization ID (o-xxxx); lets CloudTrail from the mgmt account write to the log bucket"
}
variable "alert_email" {
  type        = string
  description = "Mailbox NOT on spoolspot.com (finding F6)"
}
variable "backup_retention_days" {
  type    = number
  default = 35 # D7
}
variable "prod_apply_branch_ref" {
  type    = string
  default = "refs/heads/main"
}
variable "state_bucket" {
  sensitive   = true
  type        = string
  description = "Name of the OpenTofu state bucket created by bootstrap (ss-tfstate-<account id>); kept out of tracked files"
}
variable "mgmt_account_id" {
  sensitive   = true
  type        = string
  description = "Management (payer) account id: its org-trail logs and EventBridge alerts are delivered here; kept out of tracked files"
}
variable "identity_account_ids" {
  sensitive   = true
  type        = map(string)
  description = "Account IDs of the identity accounts by env: stg is identity-nonprod, prod is identity-prod. Used to build the state-access role trust (SPOOL-173). Gitignored tfvars only."
  validation {
    condition = (
      toset(keys(var.identity_account_ids)) == toset(["stg", "prod"]) &&
      alltrue([for v in values(var.identity_account_ids) : can(regex("^[0-9]{12}$", v))]) &&
      length(distinct(values(var.identity_account_ids))) == 2
    )
    error_message = "identity_account_ids needs exactly the keys stg and prod, each a different 12-digit account ID."
  }
}
