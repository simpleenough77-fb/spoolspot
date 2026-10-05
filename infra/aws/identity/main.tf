# SPDX-License-Identifier: AGPL-3.0-or-later
locals {
  mail_domain = "${var.mail_subdomain}.${var.zone_name}" # same derivation as the cloudflare/zone stack
}

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

  # SPOOL-190: first factor is PASSWORD only, with TOTP as the required second
  # factor (mfa_configuration ON). Passkeys (WEB_AUTHN) are not enabled: with MFA
  # ON Cognito requires factor_configuration MULTI_FACTOR_WITH_USER_VERIFICATION,
  # which the pinned aws provider cannot set. Revisit when it can (SPOOL-192).
  # Operational note: provider 6.67.0 sends SetUserPoolMfaConfig before it updates the
  # sign-in policy, so removing a first factor and turning MFA ON cannot happen in one
  # apply. Change them in separate applies (staging, SPOOL-190).
  sign_in_policy {
    allowed_first_auth_factors = ["PASSWORD"]
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
  auth_session_validity                = 3 # minutes, the shortest Cognito allows [A]
  # Each refresh issues a new refresh token and invalidates the old one after the grace period. [U] confirm with the PKCE flow in staging.
  refresh_token_rotation {
    feature                    = "ENABLED"
    retry_grace_period_seconds = 10
  }
  # The client may change the email address and nothing else. Tenant and role live server-side (ADR-0004), never in the pool.
  read_attributes  = ["email", "email_verified"]
  write_attributes = ["email"]
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
  # Cognito rejects ALLOW_REFRESH_TOKEN_AUTH while refresh token rotation is enabled (found in staging apply, SPOOL-190).
  explicit_auth_flows = ["ALLOW_USER_AUTH"]
}

# SES identity for account email (DKIM CNAMEs go to the zone stack via output).
resource "aws_sesv2_email_identity" "mail" {
  email_identity = local.mail_domain
  dkim_signing_attributes { next_signing_key_length = "RSA_2048_BIT" }
  lifecycle { prevent_destroy = true }
}
# Custom MAIL FROM so SPF aligns with the sending domain. The MX and SPF records for bounce.<mail domain> come from the
# cloudflare/zone stack (manage_ses_records). USE_DEFAULT_VALUE keeps mail flowing if the MX is missing; tighten after staging. [A]
resource "aws_sesv2_email_identity_mail_from_attributes" "mail" {
  email_identity         = aws_sesv2_email_identity.mail.email_identity
  mail_from_domain       = "bounce.${local.mail_domain}"
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}
