# SPDX-License-Identifier: AGPL-3.0-or-later
terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0" # [U] pin exactly after init
    }
  }
  backend "s3" {} # key aws/org/terraform.tfstate. HUMAN APPLY ONLY (plan section 4).
}

provider "aws" {
  region = "us-east-1" # management account, via SSO profile
  default_tags {
    tags = {
      project    = "spoolspot"
      env        = "mgmt"
      owner      = "avi"
      managed-by = "opentofu"
      ticket     = "SPOOL-70"
    }
  }
}
