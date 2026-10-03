# SPDX-License-Identifier: AGPL-3.0-or-later
output "backup_bucket" { value = aws_s3_bucket.backup.bucket }
output "log_bucket" { value = aws_s3_bucket.logs.bucket }
output "alerts_topic_arn" { value = aws_sns_topic.alerts.arn }
output "gh_role_arns" { value = { for k, r in aws_iam_role.gh : k => r.arn } }
