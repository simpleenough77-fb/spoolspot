# SPDX-License-Identifier: AGPL-3.0-or-later
output "backup_bucket" {
  value     = aws_s3_bucket.backup.bucket
  sensitive = true
}
output "log_bucket" {
  value     = aws_s3_bucket.logs.bucket
  sensitive = true
}
output "alerts_topic_arn" {
  value     = aws_sns_topic.alerts.arn
  sensitive = true
}
output "gh_role_arns" {
  value     = { for k, r in aws_iam_role.gh : k => r.arn }
  sensitive = true
}
output "tfstate_identity_role_arns" {
  value     = { for k, r in aws_iam_role.tfstate_identity : k => r.arn }
  sensitive = true
}
output "state_kms_key_arn" {
  value     = data.aws_kms_key.state.arn
  sensitive = true
}
