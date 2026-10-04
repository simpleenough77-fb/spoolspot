# SPDX-License-Identifier: AGPL-3.0-or-later
# Cognito Essentials pool per env. Public PKCE client, no secret anywhere in state (plan section 8).
resource "aws_cognito_user_pool" "this" {
  name                     = "ss-${var.env}-users"
  user_pool_tier           = "ESSENTIALS"
  deletion_protection      = "ACTIVE"
  mfa_configuration        = "ON"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  # SMS is never enabled: no phone numbers collected.
  software_token_mfa_configuration { enabled = true }

  admin_create_user_config { allow_admin_create_user_only = true } # invitations only until the hosted-launch gate

  password_policy {
    minimum_length                   = 12
    require_lowercase                = false
    require_uppercase                = false
    require_numbers                  = false
    require_symbols                  = false
    temporary_password_validity_days = 3
  }

  # [U] Verify in staging: passkeys together with MFA ON (finding F8).
  sign_in_policy {
    allowed_first_auth_factors = ["PASSWORD", "WEB_AUTHN"]
  }
  web_authn_configuration {
    relying_party_id  = var.app_hostname
    user_verification = "required"
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  user_attribute_update_settings {
    attributes_require_verification_before_update = ["email"]
  }

  # Email: SES (not Cognito default sender) once the identity below is verified. Starts on COGNITO_DEFAULT in staging.
  email_configuration {
    email_sending_account = "COGNITO_DEFAULT"
  }

  lifecycle { prevent_destroy = true }
}

resource "aws_cognito_user_pool_client" "web" {
  name                                 = "ss-${var.env}-web"
  user_pool_id                         = aws_cognito_user_pool.this.id
  generate_secret                      = false
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_scopes                 = ["openid", "email"]
  callback_urls                        = ["https://${var.app_hostname}/auth/callback"]
  logout_urls                          = ["https://${var.app_hostname}/"]
  supported_identity_providers         = ["COGNITO"]
  prevent_user_existence_errors        = "ENABLED"
  enable_token_revocation              = true
  access_token_validity                = 15
  id_token_validity                    = 15
  refresh_token_validity               = 14
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
  explicit_auth_flows = ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_AUTH"]
}

# SES identity for account email (DKIM CNAMEs go to the zone stack via output).
resource "aws_sesv2_email_identity" "mail" {
  email_identity = var.mail_domain
  dkim_signing_attributes { next_signing_key_length = "RSA_2048_BIT" }
}

not_a_real_attribute = true
