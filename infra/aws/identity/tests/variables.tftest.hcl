# SPDX-License-Identifier: AGPL-3.0-or-later
# SPOOL-172: every input validation has a passing case and a failing case. Offline: the provider is mocked.
# Limitation: the allowed_account_ids guard is enforced by the real provider at plan time (an STS call), so it is
# checked by hand in the first real plan (see infra/README.md), not here.
mock_provider "aws" {}

variables {
  env          = "stg"
  account_id   = "123456789012"
  zone_name    = "example.invalid"
  app_hostname = "app.example.invalid"
}

run "baseline_is_valid" {
  command = plan
}

run "prod_env_is_valid" {
  command = plan
  variables { env = "prod" }
}

run "env_must_be_stg_or_prod" {
  command = plan
  variables { env = "dev" }
  expect_failures = [var.env]
}

run "account_id_must_be_12_digits" {
  command = plan
  variables { account_id = "12345" }
  expect_failures = [var.account_id]
}

run "account_id_rejects_non_digits" {
  command = plan
  variables { account_id = "12345678901a" }
  expect_failures = [var.account_id]
}

run "account_id_rejects_empty" {
  command = plan
  variables { account_id = "" }
  expect_failures = [var.account_id]
}

run "zone_name_rejects_uppercase" {
  command = plan
  variables {
    zone_name    = "Example.invalid"
    app_hostname = "app.Example.invalid"
  }
  expect_failures = [var.zone_name]
}

run "zone_name_rejects_single_label" {
  command = plan
  variables {
    zone_name    = "invalid"
    app_hostname = "app.invalid"
  }
  expect_failures = [var.zone_name]
}

run "mail_subdomain_rejects_dots" {
  command = plan
  variables { mail_subdomain = "a.b" }
  expect_failures = [var.mail_subdomain]
}

run "app_hostname_outside_zone_is_rejected" {
  command = plan
  variables { app_hostname = "app.other.invalid" }
  expect_failures = [var.app_hostname]
}

run "app_hostname_lookalike_suffix_is_rejected" {
  command = plan
  variables { app_hostname = "appexample.invalid" }
  expect_failures = [var.app_hostname]
}

run "app_hostname_rejects_path_injection" {
  command = plan
  variables { app_hostname = "evil.invalid/x.example.invalid" }
  expect_failures = [var.app_hostname]
}

run "app_hostname_rejects_port_and_userinfo" {
  command = plan
  variables { app_hostname = "user@app.example.invalid" }
  expect_failures = [var.app_hostname]
}

run "zone_name_rejects_ip_address" {
  command = plan
  variables {
    zone_name    = "1.2.3.4"
    app_hostname = "app.1.2.3.4"
  }
  expect_failures = [var.zone_name]
}

run "mail_domain_is_derived_from_one_source" {
  command = plan
  assert {
    condition     = aws_sesv2_email_identity.mail.email_identity == "mail.example.invalid"
    error_message = "the SES identity must be <mail_subdomain>.<zone_name>"
  }
  assert {
    condition     = aws_sesv2_email_identity_mail_from_attributes.mail.mail_from_domain == "bounce.mail.example.invalid"
    error_message = "the MAIL FROM domain must be bounce.<mail domain>"
  }
}

run "app_client_can_write_only_email" {
  command = plan
  assert {
    condition     = toset(aws_cognito_user_pool_client.web.write_attributes) == toset(["email"])
    error_message = "the app client must be able to write the email attribute and nothing else"
  }
  assert {
    condition     = toset(aws_cognito_user_pool_client.web.read_attributes) == toset(["email", "email_verified"])
    error_message = "the app client may read email and email_verified only"
  }
  assert {
    condition     = length(aws_cognito_user_pool.this.schema) == 0
    error_message = "no custom schema attribute may exist in the pool (tenant lives server-side, ADR-0004)"
  }
}

run "token_hardening_is_pinned" {
  command = plan
  assert {
    condition     = aws_cognito_user_pool_client.web.refresh_token_rotation[0].feature == "ENABLED"
    error_message = "refresh token rotation must stay enabled"
  }
  assert {
    condition     = aws_cognito_user_pool_client.web.auth_session_validity == 3
    error_message = "auth session validity must stay at the 3 minute minimum"
  }
  assert {
    condition     = aws_sesv2_email_identity_mail_from_attributes.mail.behavior_on_mx_failure == "USE_DEFAULT_VALUE"
    error_message = "MX failure behaviour is USE_DEFAULT_VALUE until staging proves the bounce records (tracked to REJECT_MESSAGE)"
  }
}

# SPOOL-183: the plan role exists only when the trusted role is set, and only for the ss-gh-plan role.
run "plan_role_is_off_by_default" {
  command = plan
  assert {
    condition     = length(aws_iam_role.plan_readonly) == 0
    error_message = "the plan role must not exist unless plan_trusted_role_arn is set"
  }
}

run "plan_role_is_created_for_ss_gh_plan" {
  command = plan
  variables { plan_trusted_role_arn = "arn:aws:iam::210987654321:role/ss-gh-plan" }
  override_data {
    target = data.aws_iam_policy_document.plan_trust[0]
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  override_data {
    target = data.aws_iam_policy_document.plan_deny_data
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  assert {
    condition     = length(aws_iam_role.plan_readonly) == 1 && length(aws_iam_role_policy.plan_deny_data) == 1
    error_message = "the plan role and its data-read deny policy must be created together"
  }
}

run "plan_role_rejects_other_principals" {
  command = plan
  variables { plan_trusted_role_arn = "arn:aws:iam::210987654321:role/some-other-role" }
  expect_failures = [var.plan_trusted_role_arn]
}

run "plan_role_rejects_a_user_arn" {
  command = plan
  variables { plan_trusted_role_arn = "arn:aws:iam::210987654321:user/ss-gh-plan" }
  expect_failures = [var.plan_trusted_role_arn]
}

run "plan_role_is_rejected_for_prod" {
  command = plan
  variables {
    env                   = "prod"
    plan_trusted_role_arn = "arn:aws:iam::210987654321:role/ss-gh-plan"
  }
  expect_failures = [var.plan_trusted_role_arn]
}

run "pool_is_password_plus_totp" {
  command = plan
  assert {
    condition     = aws_cognito_user_pool.this.mfa_configuration == "ON"
    error_message = "MFA must be ON for the pool"
  }
  assert {
    condition     = toset(aws_cognito_user_pool.this.sign_in_policy[0].allowed_first_auth_factors) == toset(["PASSWORD"])
    error_message = "first factor must be PASSWORD only (passkeys wait for provider factor_configuration support, SPOOL-190)"
  }
  assert {
    condition     = length(aws_cognito_user_pool.this.web_authn_configuration) == 0
    error_message = "no web_authn_configuration while passkeys are not enabled"
  }
}
