# SPDX-License-Identifier: AGPL-3.0-or-later
data "aws_organizations_organization" "this" {}
data "aws_caller_identity" "current" {}

locals {
  # Services we use. Everything else is denied in member accounts (structural cost ceiling, D5).
  allowed_service_prefixes = [
    "iam", "sts", "sso", "organizations", "s3", "kms", "ssm", "cognito-idp", "cognito-identity",
    "ses", "sesv2", "cloudwatch", "logs", "sns", "events", "budgets", "cloudtrail",
    "account", "support", "tag", "ce", "access-analyzer", "health", "aws-portal", "billing", "cur",
  ]
  # Global services that live outside us-east-1 and must stay reachable.
  global_service_prefixes = [
    "iam", "sts", "organizations", "sso", "account", "budgets", "ce", "support", "health",
    "cloudfront", "route53", "route53domains", "waf", "tag", "aws-portal", "billing", "access-analyzer",
  ]
}

# Deny-based design (keeps FullAWSAccess attached, so a typo cannot lock everyone out).
resource "aws_organizations_policy" "service_allowlist" {
  name        = "ss-deny-services-outside-allowlist"
  description = "Only the services SpoolSpot uses may be called in member accounts"
  type        = "SERVICE_CONTROL_POLICY"
  content = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyOutsideAllowlist"
      Effect    = "Deny"
      NotAction = [for p in local.allowed_service_prefixes : "${p}:*"]
      Resource  = "*"
    }]
  })
}

resource "aws_organizations_policy" "region_lock" {
  name        = "ss-deny-other-regions"
  description = "us-east-1 only (ADR-0005: US-only at launch)"
  type        = "SERVICE_CONTROL_POLICY"
  content = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyOtherRegions"
      Effect    = "Deny"
      NotAction = [for p in local.global_service_prefixes : "${p}:*"]
      Resource  = "*"
      Condition = { StringNotEquals = { "aws:RequestedRegion" = [var.allowed_region] } }
    }]
  })
}

resource "aws_organizations_policy" "no_long_lived_keys" {
  name        = "ss-deny-long-lived-credentials"
  description = "No IAM users, access keys or login profiles; no root use; protect logging and backups"
  type        = "SERVICE_CONTROL_POLICY"
  content = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "DenyUsersAndKeys"
        Effect   = "Deny"
        Action   = ["iam:CreateUser", "iam:CreateAccessKey", "iam:CreateLoginProfile", "iam:UpdateAccessKey"]
        Resource = "*"
      },
      {
        Sid       = "DenyMemberRoot"
        Effect    = "Deny"
        Action    = "*"
        Resource  = "*"
        Condition = { StringLike = { "aws:PrincipalArn" = "arn:aws:iam::*:root" } }
      },
      {
        Sid      = "DenyLeaveOrg"
        Effect   = "Deny"
        Action   = ["organizations:LeaveOrganization"]
        Resource = "*"
      },
      {
        Sid      = "DenyStoppingTrail"
        Effect   = "Deny"
        Action   = ["cloudtrail:StopLogging", "cloudtrail:DeleteTrail", "cloudtrail:UpdateTrail", "cloudtrail:PutEventSelectors"]
        Resource = "*"
      },
      {
        Sid      = "DenyKmsDisableAndDelete"
        Effect   = "Deny"
        Action   = ["kms:DisableKey", "kms:ScheduleKeyDeletion"]
        Resource = "*"
        # break-glass: detach this SCP deliberately from the mgmt account, never from a role in a member account
      },
    ]
  })
}

# Applied automatically by the budget action at 100% of the AWS budget.
resource "aws_organizations_policy" "budget_cutoff" {
  name        = "ss-budget-cutoff-deny-all-but-read"
  description = "Attached by the AWS Budgets action when the AWS budget is exceeded; detach manually to restore"
  type        = "SERVICE_CONTROL_POLICY"
  content = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "DenyCreateAndWrite"
      Effect   = "Deny"
      Action   = ["s3:CreateBucket", "kms:CreateKey", "cognito-idp:Create*", "ses:Create*", "sesv2:Create*", "sns:Create*", "cloudwatch:PutMetricAlarm"]
      Resource = "*"
    }]
  })
}

resource "aws_organizations_policy_attachment" "allowlist" {
  for_each  = toset(var.member_account_ids)
  policy_id = aws_organizations_policy.service_allowlist.id
  target_id = each.value
}
resource "aws_organizations_policy_attachment" "region" {
  for_each  = toset(var.member_account_ids)
  policy_id = aws_organizations_policy.region_lock.id
  target_id = each.value
}
resource "aws_organizations_policy_attachment" "keys" {
  for_each  = toset(var.member_account_ids)
  policy_id = aws_organizations_policy.no_long_lived_keys.id
  target_id = each.value
}

# ---------- Organization trail (management events) ----------
resource "aws_cloudtrail" "org" {
  #checkov:skip=CKV_AWS_35:ADR-0013 expires 2027-04-01, trail contents not Restricted, third KMS key not justified
  #checkov:skip=CKV2_AWS_10:ADR-0013 expires 2027-04-01, EventBridge rules already alert, CloudWatch Logs adds cost
  #checkov:skip=CKV_AWS_252:ADR-0013 expires 2027-04-01, alerts use EventBridge to the ss-alerts topic
  name                          = "ss-org-trail"
  s3_bucket_name                = var.log_bucket
  is_organization_trail         = true
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true
}

# ---------- Security event alerts (EventBridge -> SNS; free, plan section 10) ----------
# Management-account events only. Rules for shared-account events (KMS, bucket policy) live in aws/shared.
locals {
  alert_rules = {
    root-signin = {
      pattern = { "detail-type" = ["AWS Console Sign In via CloudTrail"], detail = { userIdentity = { type = ["Root"] } } }
    }
    signin-no-mfa = {
      pattern = { "detail-type" = ["AWS Console Sign In via CloudTrail"], detail = { additionalEventData = { MFAUsed = ["No"] } } }
    }
    trail-tampering = {
      pattern = { source = ["aws.cloudtrail"], detail = { eventName = ["StopLogging", "DeleteTrail", "UpdateTrail"] } }
    }
    iam-scp-changes = {
      pattern = { source = ["aws.iam", "aws.organizations"], detail = { eventName = [
        # aws.iam
        "CreateAccessKey", "CreateUser", "CreateLoginProfile", "UpdateAssumeRolePolicy",
        "AttachRolePolicy", "AttachUserPolicy", "PutRolePolicy", "PutUserPolicy",
        # aws.organizations (SCPs)
        "AttachPolicy", "DetachPolicy", "DeletePolicy", "UpdatePolicy", "CreatePolicy",
      ] } }
    }
  }
}

resource "aws_cloudwatch_event_rule" "alerts" {
  for_each      = local.alert_rules
  name          = "ss-alert-${each.key}"
  event_pattern = jsonencode(each.value.pattern)
}
# A cross-account SNS target needs a role in this account (EventBridge returns "RoleArn is required").
resource "aws_iam_role" "events_to_sns" {
  name = "ss-events-to-sns"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
    }]
  })
}
resource "aws_iam_role_policy" "events_to_sns" {
  name = "publish-to-ss-alerts"
  role = aws_iam_role.events_to_sns.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sns:Publish", Resource = var.alerts_topic_arn }]
  })
}
resource "aws_cloudwatch_event_target" "alerts" {
  for_each = local.alert_rules
  rule     = aws_cloudwatch_event_rule.alerts[each.key].name
  arn      = var.alerts_topic_arn
  role_arn = aws_iam_role.events_to_sns.arn
}

# ---------- Budgets ----------
resource "aws_budgets_budget" "aws_monthly" {
  name         = "ss-aws-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.aws_monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = [50, 80, 100]
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [var.budget_email]
    }
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_email]
  }
}

# Automatic cutoff: at 100% actual, attach the cutoff SCP to member accounts.
# [U] Needs an execution role that Budgets can assume; created at checkpoint 3 after the first plan.
# Left as a documented follow-up rather than guessed here.
