# SPDX-License-Identifier: AGPL-3.0-or-later
# SPOOL-170: d1_jurisdiction accepts exactly eu, us and fedramp. Offline: the provider is mocked.
mock_provider "cloudflare" {}

variables {
  account_id = "0123456789abcdef0123456789abcdef"
  env        = "stg"
}

run "default_jurisdiction_is_valid" {
  command = plan
}

run "eu_is_valid" {
  command = plan
  variables { d1_jurisdiction = "eu" }
}

run "fedramp_is_valid" {
  command = plan
  variables { d1_jurisdiction = "fedramp" }
}

run "unknown_jurisdiction_is_rejected" {
  command = plan
  variables { d1_jurisdiction = "xx" }
  expect_failures = [var.d1_jurisdiction]
}

run "uppercase_jurisdiction_is_rejected" {
  command = plan
  variables { d1_jurisdiction = "US" }
  expect_failures = [var.d1_jurisdiction]
}

run "env_must_be_stg_or_prod" {
  command = plan
  variables { env = "dev" }
  expect_failures = [var.env]
}
