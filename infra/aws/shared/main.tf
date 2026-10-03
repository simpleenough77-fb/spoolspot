# SPDX-License-Identifier: AGPL-3.0-or-later
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  repo       = var.github_repo
  oidc_host  = "token.actions.githubusercontent.com"
  root_arn   = "arn:${data.aws_partition.current.partition}:iam::${local.account_id}:root"
}

# ---------- KMS ----------
resource "aws_kms_key" "backup" {
  description             = "ss-backup: encrypts D1 export backups (Confidential)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AccountRoot"
      Effect    = "Allow"
      Principal = { AWS = local.root_arn }
      Action    = "kms:*"
      Resource  = "*"
    }]
  })
}
resource "aws_kms_alias" "backup" {
  name          = "alias/ss-backup"
  target_key_id = aws_kms_key.backup.key_id
}

# ---------- Backup bucket: Object Lock, compliance mode ----------
resource "aws_s3_bucket" "backup" {
  #checkov:skip=CKV_AWS_144:ADR-0013 expires 2027-04-01, us-east-1 only region lock, Object Lock and versioning protect the data
  #checkov:skip=CKV2_AWS_62:ADR-0013 expires 2027-04-01, no consumer for bucket events, covered by trail and EventBridge alerts
  bucket              = "ss-backup-${local.account_id}"
  object_lock_enabled = true
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_versioning" "backup" {
  bucket = aws_s3_bucket.backup.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_object_lock_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id
  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = var.backup_retention_days
    }
  }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.backup.arn
    }
    bucket_key_enabled = true
  }
}
resource "aws_s3_bucket_public_access_block" "backup" {
  bucket                  = aws_s3_bucket.backup.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_ownership_controls" "backup" {
  bucket = aws_s3_bucket.backup.id
  rule { object_ownership = "BucketOwnerEnforced" }
}
resource "aws_s3_bucket_lifecycle_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id
  rule {
    id     = "expire-after-retention"
    status = "Enabled"
    filter {}
    expiration { days = var.backup_retention_days + 1 }
    noncurrent_version_expiration { noncurrent_days = var.backup_retention_days + 1 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}
data "aws_iam_policy_document" "backup_bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.backup.arn, "${aws_s3_bucket.backup.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
  statement {
    sid       = "DenyWeakeningObjectLock"
    effect    = "Deny"
    actions   = ["s3:PutBucketObjectLockConfiguration", "s3:BypassGovernanceRetention", "s3:PutBucketVersioning"]
    resources = [aws_s3_bucket.backup.arn, "${aws_s3_bucket.backup.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}
resource "aws_s3_bucket_policy" "backup" {
  bucket = aws_s3_bucket.backup.id
  policy = data.aws_iam_policy_document.backup_bucket.json
}

# ---------- Log bucket (CloudTrail org trail, security log pulls) ----------
resource "aws_s3_bucket" "logs" {
  #checkov:skip=CKV_AWS_144:ADR-0013 expires 2027-04-01, us-east-1 only region lock, Object Lock and versioning protect the data
  #checkov:skip=CKV2_AWS_62:ADR-0013 expires 2027-04-01, no consumer for bucket events, covered by trail and EventBridge alerts
  #checkov:skip=CKV_AWS_18:ADR-0013 expires 2027-04-01, log bucket cannot log to itself, covered by CloudTrail management events
  #checkov:skip=CKV_AWS_145:ADR-0013 expires 2027-04-01, trail contents not Restricted, third KMS key not justified
  bucket              = "ss-logs-${local.account_id}"
  object_lock_enabled = true
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_versioning" "logs" {
  bucket = aws_s3_bucket.logs.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_object_lock_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = 90 # security log retention; question for counsel (plan section 19)
    }
  }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" } # CloudTrail delivery works with SSE-S3; switch to a CMK later if wanted
  }
}
resource "aws_s3_bucket_public_access_block" "logs" {
  bucket                  = aws_s3_bucket.logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_ownership_controls" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule { object_ownership = "BucketOwnerEnforced" }
}
resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    id     = "expire-trail-after-1y"
    status = "Enabled"
    filter { prefix = "AWSLogs/" }
    expiration { days = 365 }
    noncurrent_version_expiration { noncurrent_days = 365 }
  }
  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}
data "aws_iam_policy_document" "logs_bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.logs.arn, "${aws_s3_bucket.logs.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
  statement {
    sid       = "CloudTrailAclCheck"
    effect    = "Allow"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.logs.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
  }
  statement {
    sid     = "CloudTrailWriteOrg"
    effect  = "Allow"
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.logs.arn}/AWSLogs/${var.org_id}/*",
      "${aws_s3_bucket.logs.arn}/AWSLogs/${var.mgmt_account_id}/*", # an org trail writes the management account's own logs under its account id
    ]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
  }
}
resource "aws_s3_bucket_policy" "logs" {
  bucket = aws_s3_bucket.logs.id
  policy = data.aws_iam_policy_document.logs_bucket.json
}

# ---------- S3 server access log bucket (ADR-0013 control) ----------
# Separate from the log bucket above: S3 server access log delivery to a bucket with Object Lock
# is not something we have verified [U], and a silent delivery failure would be a useless control.
# Short retention, no Object Lock. Holds access records for the state and backup buckets only.
resource "aws_s3_bucket" "access_logs" {
  #checkov:skip=CKV_AWS_144:ADR-0013 expires 2027-04-01, us-east-1 only region lock, Object Lock and versioning protect the data
  #checkov:skip=CKV2_AWS_62:ADR-0013 expires 2027-04-01, no consumer for bucket events, covered by trail and EventBridge alerts
  #checkov:skip=CKV_AWS_145:ADR-0013 expires 2027-04-01, S3 server access log delivery does not support KMS targets
  bucket = "ss-access-logs-${local.account_id}"
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_versioning" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" } # S3 log delivery does not support SSE-KMS targets
  }
}
resource "aws_s3_bucket_public_access_block" "access_logs" {
  bucket                  = aws_s3_bucket.access_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_ownership_controls" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule { object_ownership = "BucketOwnerEnforced" }
}
resource "aws_s3_bucket_lifecycle_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule {
    id     = "expire-access-logs-after-90d"
    status = "Enabled"
    filter {}
    expiration { days = 90 }
    noncurrent_version_expiration { noncurrent_days = 7 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}
data "aws_iam_policy_document" "access_logs_bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.access_logs.arn, "${aws_s3_bucket.access_logs.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
  statement {
    sid       = "S3ServerAccessLogDelivery"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.access_logs.arn}/s3/*"]
    principals {
      type        = "Service"
      identifiers = ["logging.s3.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [aws_s3_bucket.backup.arn, "arn:${data.aws_partition.current.partition}:s3:::${var.state_bucket}"]
    }
  }
}
resource "aws_s3_bucket_policy" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  policy = data.aws_iam_policy_document.access_logs_bucket.json
}
resource "aws_s3_bucket_logging" "backup" {
  bucket        = aws_s3_bucket.backup.id
  target_bucket = aws_s3_bucket.access_logs.id
  target_prefix = "s3/backup/"
  depends_on    = [aws_s3_bucket_policy.access_logs]
}
# The state bucket lives in the bootstrap stack, which runs before this bucket exists, so its
# logging is attached here. Checkov scans per stack and will still flag the bootstrap bucket (ADR-0013).
resource "aws_s3_bucket_logging" "state" {
  bucket        = var.state_bucket
  target_bucket = aws_s3_bucket.access_logs.id
  target_prefix = "s3/state/"
  depends_on    = [aws_s3_bucket_policy.access_logs]
}

# ---------- SNS alerts (email only; no paging yet, plan section 10) ----------
# Not encrypted with alias/aws/sns on purpose: EventBridge cannot publish to a topic that uses the AWS managed key.
# Alerts carry event metadata only (ADR-0013 records the finding). A customer-managed key would cost about $1 a month.
resource "aws_sns_topic" "alerts" {
  #checkov:skip=CKV_AWS_26:ADR-0013 expires 2027-04-01, EventBridge cannot publish to a topic using the AWS managed key, alerts hold event metadata only
  name = "ss-alerts"
}
data "aws_iam_policy_document" "alerts_topic" {
  statement {
    sid       = "AccountOwner"
    effect    = "Allow"
    actions   = ["sns:GetTopicAttributes", "sns:SetTopicAttributes", "sns:AddPermission", "sns:RemovePermission", "sns:DeleteTopic", "sns:Subscribe", "sns:ListSubscriptionsByTopic", "sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceOwner"
      values   = [local.account_id]
    }
  }
  statement {
    sid       = "EventBridgeThisAccount"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
  # Management-account rules publish through the role ss-events-to-sns (created in aws/org). The role is
  # matched by ARN condition, so this policy does not require the role to exist yet.
  statement {
    sid       = "ManagementAccountEventsRole"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${var.mgmt_account_id}:root"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:PrincipalArn"
      values   = ["arn:${data.aws_partition.current.partition}:iam::${var.mgmt_account_id}:role/ss-events-to-sns"]
    }
  }
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}
resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts_topic.json
}
# Rules for events in THIS account. EventBridge buses are per account, so rules in the management
# account never see these events.
locals {
  shared_alert_rules = {
    kms-disable-delete = {
      source = ["aws.kms"]
      detail = { eventName = ["DisableKey", "ScheduleKeyDeletion"] }
    }
    bucket-policy-or-lock-change = {
      source = ["aws.s3"]
      detail = { eventName = ["PutBucketPolicy", "DeleteBucketPolicy", "PutBucketObjectLockConfiguration"] }
    }
  }
}
resource "aws_cloudwatch_event_rule" "shared_alerts" {
  for_each = local.shared_alert_rules
  name     = "ss-alert-${each.key}"
  event_pattern = jsonencode({
    source = each.value.source
    detail = each.value.detail
  })
}
resource "aws_cloudwatch_event_target" "shared_alerts" {
  for_each   = local.shared_alert_rules
  rule       = aws_cloudwatch_event_rule.shared_alerts[each.key].name
  arn        = aws_sns_topic.alerts.arn
  depends_on = [aws_sns_topic_policy.alerts]
}
resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email # subscriber must confirm the email manually
}

# ---------- SSM parameter NAMES only; real values set out of band ----------
resource "aws_ssm_parameter" "cf_d1_export_token" {
  name   = "/ss/prod/backup/cf-d1-export-token"
  type   = "SecureString"
  value  = "UNSET-set-out-of-band"
  key_id = aws_kms_key.backup.arn
  lifecycle { ignore_changes = [value] }
}
resource "aws_ssm_parameter" "cf_drift_read_token" {
  name   = "/ss/prod/drift/cf-read-token"
  type   = "SecureString"
  value  = "UNSET-set-out-of-band"
  key_id = aws_kms_key.backup.arn
  lifecycle { ignore_changes = [value] }
}

# ---------- GitHub OIDC roles: pinned to repo, ref/environment and workflow ----------
locals {
  roles = {
    "ss-gh-plan" = {
      sub = ["repo:${local.repo}:pull_request"]
      job = null
    }
    "ss-gh-apply-aws" = {
      sub = ["repo:${local.repo}:environment:aws-apply"]
      job = "${local.repo}/.github/workflows/infra-apply.yml@${var.prod_apply_branch_ref}"
    }
    "ss-gh-backup-prod" = {
      sub = ["repo:${local.repo}:environment:backup-prod"]
      job = "${local.repo}/.github/workflows/backup-prod.yml@${var.prod_apply_branch_ref}"
    }
    "ss-gh-drift-prod" = {
      sub = ["repo:${local.repo}:environment:prod-plan"]
      job = "${local.repo}/.github/workflows/drift.yml@${var.prod_apply_branch_ref}"
    }
  }
}

data "aws_iam_policy_document" "trust" {
  for_each = local.roles
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [var.oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = each.value.sub
    }
    dynamic "condition" {
      for_each = each.value.job == null ? [] : [each.value.job]
      content {
        test     = "StringEquals"
        variable = "${local.oidc_host}:job_workflow_ref"
        values   = [condition.value]
      }
    }
  }
}

resource "aws_iam_role" "gh" {
  for_each             = local.roles
  name                 = each.key
  assume_role_policy   = data.aws_iam_policy_document.trust[each.key].json
  max_session_duration = 3600
}

# backup role: PutObject on daily/ only, one KMS action, one SSM parameter. Nothing else.
data "aws_iam_policy_document" "backup_role" {
  statement {
    actions   = ["s3:PutObject", "s3:PutObjectRetention"]
    resources = ["${aws_s3_bucket.backup.arn}/daily/*"]
  }
  statement {
    actions   = ["kms:GenerateDataKey", "kms:Encrypt"]
    resources = [aws_kms_key.backup.arn]
  }
  statement {
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.cf_d1_export_token.arn]
  }
}
resource "aws_iam_role_policy" "backup" {
  name   = "backup-write"
  role   = aws_iam_role.gh["ss-gh-backup-prod"].id
  policy = data.aws_iam_policy_document.backup_role.json
}

# drift/freshness role: list+head on backups, read its own token.
data "aws_iam_policy_document" "drift_role" {
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.backup.arn]
  }
  statement {
    actions   = ["s3:GetObject", "s3:GetObjectAttributes"]
    resources = ["${aws_s3_bucket.backup.arn}/daily/*"]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.backup.arn]
  }
  statement {
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.cf_drift_read_token.arn]
  }
}
resource "aws_iam_role_policy" "drift" {
  name   = "drift-read"
  role   = aws_iam_role.gh["ss-gh-drift-prod"].id
  policy = data.aws_iam_policy_document.drift_role.json
}

# plan role: AWS-managed ReadOnlyAccess plus state read (state bucket policy grants access by role name pattern in the bootstrap stack at checkpoint 3).
resource "aws_iam_role_policy_attachment" "plan_ro" {
  role       = aws_iam_role.gh["ss-gh-plan"].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/ReadOnlyAccess"
}
# apply role scope is finalised at checkpoint 3 after the first real plan shows the exact actions needed.
