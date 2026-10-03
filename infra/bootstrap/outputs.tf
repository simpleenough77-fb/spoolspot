# SPDX-License-Identifier: AGPL-3.0-or-later
output "state_bucket" { value = aws_s3_bucket.state.bucket }
output "oidc_provider_arn" { value = aws_iam_openid_connect_provider.github.arn }
output "state_kms_alias" { value = aws_kms_alias.state.name }
