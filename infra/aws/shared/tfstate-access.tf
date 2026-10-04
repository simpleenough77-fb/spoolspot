# SPDX-License-Identifier: AGPL-3.0-or-later
# SPOOL-173: how the identity stacks reach the OpenTofu state bucket, which lives in this (Shared) account.
#
# Design (Option A): one role per identity env in THIS account, assumed by the backend. The bucket policy and the
# state KMS key policy (bootstrap stack) are not touched: the key policy already delegates to IAM in this account,
# and same-account IAM needs no bucket-policy grant. Every state access is an AssumeRole event in CloudTrail.
#
# Each role can touch exactly one state object (and its lock object), list only its own prefix, and use the state key
# only through S3. stg cannot read prod state and prod cannot read stg state.
data "aws_region" "current" {}

# Same account as this stack. The full ARN goes into the gitignored identity backend files.
data "aws_kms_key" "state" {
  key_id = "alias/ss-state"
}

locals {
  state_envs       = toset(["stg", "prod"])
  state_keys       = { for e in local.state_envs : e => "aws/identity/${e}/terraform.tfstate" }
  state_bucket_arn = "arn:${data.aws_partition.current.partition}:s3:::${var.state_bucket}"
  # SSO role names are AWSReservedSSO_<permission set>_<16-character hash>, under /aws-reserved/sso.amazonaws.com/
  # (plus a region segment when the Identity Center home region is not us-east-1). The pattern pins the permission
  # set name and the hash length, so a different permission set (for example SpoolSpot-Admin_ReadOnly) does not match.
  sso_admin_role_patterns = [
    "role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_SpoolSpot-Admin_????????????????",
    "role/aws-reserved/sso.amazonaws.com/*/AWSReservedSSO_SpoolSpot-Admin_????????????????",
  ]
}

# Trust: only the SpoolSpot-Admin SSO role of the MATCHING identity account, and only inside the organization.
data "aws_iam_policy_document" "tfstate_trust" {
  for_each = local.state_envs
  statement {
    sid     = "AssumeFromMatchingIdentityAccountAdmin"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${var.identity_account_ids[each.key]}:root"]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:PrincipalArn"
      values   = [for p in local.sso_admin_role_patterns : "arn:${data.aws_partition.current.partition}:iam::${var.identity_account_ids[each.key]}:${p}"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:PrincipalOrgID"
      values   = [var.org_id]
    }
  }
}

resource "aws_iam_role" "tfstate_identity" {
  for_each             = local.state_envs
  name                 = "ss-tfstate-identity-${each.key}"
  description          = "SPOOL-173: OpenTofu state access for the ${each.key} identity stack. Assumed by the S3 backend."
  assume_role_policy   = data.aws_iam_policy_document.tfstate_trust[each.key].json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "tfstate_access" {
  for_each = local.state_envs

  # The state object: read and write, never delete (the bucket is versioned, and no workspace is used).
  statement {
    sid       = "StateObjectReadWrite"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${local.state_bucket_arn}/${local.state_keys[each.key]}"]
  }

  # Native S3 locking writes and removes <key>.tflock.
  statement {
    sid       = "LockObject"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${local.state_bucket_arn}/${local.state_keys[each.key]}.tflock"]
  }

  # Listing is limited to this env's prefix and the empty workspace prefix the backend probes on init.
  # StringLikeIfExists: a GetObject on a state key that does not exist yet carries no s3:prefix, and S3 answers 404
  # (empty state) only when the caller has s3:ListBucket on the bucket; without it the first init would get 403.
  # [U] confirm in the first cross-account init (runbook test). A list call with a prefix outside the two patterns is denied.
  statement {
    sid       = "ListOwnPrefixOnly"
    actions   = ["s3:ListBucket"]
    resources = [local.state_bucket_arn]
    condition {
      test     = "StringLikeIfExists"
      variable = "s3:prefix"
      values   = ["aws/identity/${each.key}/*", "env:/"]
    }
  }

  # The state key, used only through S3 in this region.
  statement {
    sid       = "StateKeyViaS3Only"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = [data.aws_kms_key.state.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${data.aws_region.current.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "tfstate_identity" {
  for_each = local.state_envs
  name     = "tfstate-access"
  role     = aws_iam_role.tfstate_identity[each.key].id
  policy   = data.aws_iam_policy_document.tfstate_access[each.key].json
}
