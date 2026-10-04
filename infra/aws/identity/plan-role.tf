# SPDX-License-Identifier: AGPL-3.0-or-later
# SPOOL-183: read-only role for plan-only CI (plan, never apply). Assumed by the Shared account's ss-gh-plan role
# (which holds the GitHub OIDC trust for pull_request runs of infra-plan.yml). Created only when plan_trusted_role_arn
# is set, so a first apply of this stack needs no CI wiring.
variable "plan_trusted_role_arn" {
  type        = string
  default     = null
  description = "ARN of the ss-gh-plan role in the Shared account (output gh_role_arns of infra/aws/shared). Null disables the plan role. Gitignored tfvars."
  validation {
    condition     = var.plan_trusted_role_arn == null || can(regex("^arn:aws:iam::[0-9]{12}:role/ss-gh-plan$", var.plan_trusted_role_arn))
    error_message = "plan_trusted_role_arn must be null or arn:aws:iam::<12 digits>:role/ss-gh-plan."
  }
  # Pull-request runs can edit the workflow they run, so the plan role must never exist in prod.
  validation {
    condition     = var.plan_trusted_role_arn == null || var.env == "stg"
    error_message = "plan_trusted_role_arn may be set for env = stg only; pull-request plans never reach prod."
  }
}

data "aws_iam_policy_document" "plan_trust" {
  count = var.plan_trusted_role_arn == null ? 0 : 1
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = [var.plan_trusted_role_arn]
    }
  }
}

resource "aws_iam_role" "plan_readonly" {
  count                = var.plan_trusted_role_arn == null ? 0 : 1
  name                 = "ss-plan-readonly"
  description          = "SPOOL-183: read-only plan role for CI. Cannot create, change or delete anything and cannot read secrets, objects or user data."
  assume_role_policy   = data.aws_iam_policy_document.plan_trust[0].json
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "plan_readonly" {
  count      = var.plan_trusted_role_arn == null ? 0 : 1
  role       = aws_iam_role.plan_readonly[0].name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

# ReadOnlyAccess still allows reading user records, secret values, log contents, suppression lists and object contents. A plan needs configuration
# only, so these are denied explicitly, whatever is attached later.
data "aws_iam_policy_document" "plan_deny_data" {
  statement {
    effect = "Deny"
    actions = [
      "cognito-idp:AdminGet*",
      "cognito-idp:AdminList*",
      "cognito-idp:GetDevice",
      "cognito-idp:GetUser",
      "cognito-idp:ListDevices",
      "cognito-idp:ListUsers*",
      "kms:Decrypt",
      "logs:FilterLogEvents",
      "logs:GetLogEvents",
      "logs:GetLogRecord",
      "logs:GetQueryResults",
      "logs:StartQuery",
      "s3:GetObject*",
      "secretsmanager:GetSecretValue",
      "sesv2:GetSuppressedDestination",
      "sesv2:ListSuppressedDestinations",
      "ssm:GetParameter*",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "plan_deny_data" {
  count  = var.plan_trusted_role_arn == null ? 0 : 1
  name   = "plan-deny-data-reads"
  role   = aws_iam_role.plan_readonly[0].id
  policy = data.aws_iam_policy_document.plan_deny_data.json
}
