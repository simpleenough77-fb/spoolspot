# SPDX-License-Identifier: AGPL-3.0-or-later
output "user_pool_id" { value = aws_cognito_user_pool.this.id }
output "client_id" { value = aws_cognito_user_pool_client.web.id }
output "ses_dkim_tokens" { value = aws_sesv2_email_identity.mail.dkim_signing_attributes[0].tokens }
