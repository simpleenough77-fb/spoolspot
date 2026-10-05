# SPDX-License-Identifier: AGPL-3.0-or-later
# SPOOL-170: every input validation has a passing case and a failing case. Offline: the provider is mocked.
# Limitation: the mocked provider cannot exercise import blocks (OpenTofu 1.13.1 panics on import in tests), so the
# import wiring is checked by the first real plan and scripts/tofu-plan-check.sh, not here.
mock_provider "cloudflare" {}

variables {
  zone_id       = "0123456789abcdef0123456789abcdef"
  pi_private_ip = "192.168.10.20"
  dmarc_rua     = "mailto:dmarc@spoolspot.com" # in the default zone_name: the DMARC authorization check passes
}

run "baseline_is_valid" {
  command = plan
}

# SPOOL-170: the resolver record is imported, so its attributes must equal the live record (TTL Auto, no comment).
run "resolver_record_matches_live" {
  command = plan
  assert {
    condition     = cloudflare_dns_record.t_pi[0].ttl == 1 && cloudflare_dns_record.t_pi[0].proxied == false
    error_message = "t_pi must match the live record: ttl 1 (Auto), not proxied."
  }
  assert {
    condition     = cloudflare_dns_record.t_pi[0].comment == null
    error_message = "t_pi must not carry a comment while it is being imported from a record that has none."
  }
}

run "zone_id_must_be_32_hex" {
  command = plan
  variables { zone_id = "not-a-zone-id" }
  expect_failures = [var.zone_id]
}

run "zone_id_rejects_uppercase" {
  command = plan
  variables { zone_id = "0123456789ABCDEF0123456789ABCDEF" }
  expect_failures = [var.zone_id]
}

run "pi_ip_may_be_unset" {
  command = plan
  variables { pi_private_ip = null }
}

run "pi_ip_accepts_each_rfc1918_range" {
  command = plan
  variables { pi_private_ip = "10.1.2.3" }
}

run "pi_ip_accepts_172_16_upper_edge" {
  command = plan
  variables { pi_private_ip = "172.31.255.254" }
}

run "pi_ip_rejects_public_address" {
  command = plan
  variables { pi_private_ip = "8.8.8.8" }
  expect_failures = [var.pi_private_ip]
}

run "pi_ip_rejects_just_outside_172_16" {
  command = plan
  variables { pi_private_ip = "172.32.0.1" }
  expect_failures = [var.pi_private_ip]
}

run "pi_ip_rejects_prefix_notation" {
  command = plan
  variables { pi_private_ip = "10.0.0.5/24" }
  expect_failures = [var.pi_private_ip]
}

run "pi_ip_rejects_garbage" {
  command = plan
  variables { pi_private_ip = "not-an-ip" }
  expect_failures = [var.pi_private_ip]
}

run "dmarc_rua_needs_mailto" {
  command = plan
  variables { dmarc_rua = "dmarc@example.invalid" }
  expect_failures = [var.dmarc_rua]
}

run "dmarc_rua_needs_an_address" {
  command = plan
  variables { dmarc_rua = "mailto:" }
  expect_failures = [var.dmarc_rua]
}

run "resolver_host_inside_zone" {
  command = plan
  variables {
    zone_name     = "example.invalid"
    resolver_host = "t.example.invalid"
    dmarc_rua     = "mailto:dmarc@example.invalid"
  }
}

run "resolver_host_outside_zone_is_rejected" {
  command = plan
  variables {
    zone_name     = "example.invalid"
    dmarc_rua     = "mailto:dmarc@example.invalid"
    resolver_host = "t.other.invalid"
  }
  expect_failures = [var.resolver_host]
}

run "resolver_host_lookalike_suffix_is_rejected" {
  command = plan
  variables {
    zone_name     = "example.invalid"
    dmarc_rua     = "mailto:dmarc@example.invalid"
    resolver_host = "tnotexample.invalid"
  }
  expect_failures = [var.resolver_host]
}

run "t_record_id_must_be_32_hex" {
  command = plan
  variables { t_record_id = "abc" }
  expect_failures = [var.t_record_id]
}

run "t_record_id_needs_the_pi_record_to_exist" {
  command = plan
  variables {
    pi_private_ip = null
    t_record_id   = "fedcba9876543210fedcba9876543210"
  }
  expect_failures = [var.t_record_id]
}

run "ratelimit_ruleset_id_must_be_32_hex" {
  command = plan
  variables { ratelimit_ruleset_id = "zones/abc/def" }
  expect_failures = [var.ratelimit_ruleset_id]
}

run "pi_ip_rejects_leading_zero_octet" {
  command = plan
  variables { pi_private_ip = "192.168.010.20" }
  expect_failures = [var.pi_private_ip]
}

run "pi_ip_rejects_octet_over_255" {
  command = plan
  variables { pi_private_ip = "10.0.0.300" }
  expect_failures = [var.pi_private_ip]
}

run "dmarc_rua_rejects_quote" {
  command = plan
  variables { dmarc_rua = "mailto:a@example.invalid\"; p=none" }
  expect_failures = [var.dmarc_rua]
}

run "dmarc_rua_rejects_semicolon" {
  command = plan
  variables { dmarc_rua = "mailto:a@example.invalid;ruf=mailto:b@example.invalid" }
  expect_failures = [var.dmarc_rua]
}

run "dmarc_rua_rejects_whitespace" {
  command = plan
  variables { dmarc_rua = "mailto:a@example.invalid x" }
  expect_failures = [var.dmarc_rua]
}

run "resolver_host_rejects_empty_label" {
  command = plan
  variables {
    zone_name     = "example.invalid"
    dmarc_rua     = "mailto:dmarc@example.invalid"
    resolver_host = ".example.invalid"
  }
  expect_failures = [var.resolver_host]
}

run "resolver_host_rejects_uppercase" {
  command = plan
  variables {
    zone_name     = "example.invalid"
    dmarc_rua     = "mailto:dmarc@example.invalid"
    resolver_host = "T.example.invalid"
  }
  expect_failures = [var.resolver_host]
}

run "dmarc_rua_needs_an_at_sign" {
  command = plan
  variables { dmarc_rua = "mailto:dmarc" }
  expect_failures = [var.dmarc_rua]
}

run "caa_issuers_rejects_parameters" {
  command = plan
  variables { caa_issuers = ["pki.goog; cansignhttpexchanges=yes"] }
  expect_failures = [var.caa_issuers]
}

run "caa_issuers_rejects_empty_list" {
  command = plan
  variables { caa_issuers = [] }
  expect_failures = [var.caa_issuers]
}

run "caa_issuers_default_excludes_digicert" {
  command = plan
  assert {
    condition     = !contains(keys(cloudflare_dns_record.caa_issue), "digicert.com")
    error_message = "digicert.com is not on Cloudflare's CA list"
  }
}

run "caa_issuewild_mirrors_issue" {
  command = plan
  assert {
    condition     = length(cloudflare_dns_record.caa_issuewild) == length(cloudflare_dns_record.caa_issue)
    error_message = "issuewild must cover the same CAs as issue"
  }
}

run "spf_record_id_must_be_32_hex" {
  command = plan
  variables { spf_record_id = "abc" }
  expect_failures = [var.spf_record_id]
}

run "dmarc_rua_in_another_domain_warns" {
  command = plan
  variables { dmarc_rua = "mailto:reports@elsewhere.invalid" }
  expect_failures = [check.dmarc_rua_authorization]
}

run "dmarc_rua_on_a_subdomain_of_the_zone_is_allowed" {
  command = plan
  variables { dmarc_rua = "mailto:Reports@Mail.SpoolSpot.com" }
}
