# SPDX-License-Identifier: AGPL-3.0-or-later
variable "member_account_ids" {
  type        = list(string)
  description = "shared, identity-prod, identity-nonprod account IDs (kept out of the repo)"
}
variable "log_bucket" {
  sensitive   = true
  type        = string
  description = "Output of aws/shared (CloudTrail destination)"
}
variable "alerts_topic_arn" {
  sensitive   = true
  type        = string
  description = "SNS topic in the shared account. Its policy (aws/shared) allows events.amazonaws.com from the management account."
}
variable "budget_email" {
  type        = string
  description = "Mailbox NOT on spoolspot.com"
}
variable "aws_monthly_budget_usd" {
  type    = number
  default = 10 # AWS share of the $25 ceiling (D5)
}
variable "allowed_region" {
  type    = string
  default = "us-east-1"
}
