# SPDX-License-Identifier: AGPL-3.0-or-later
variable "github_repo" {
  description = "owner/repo allowed to assume roles via OIDC, e.g. avivi/spoolspot"
  type        = string
}
