# SPDX-License-Identifier: AGPL-3.0-or-later
terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0" # [U] pin exactly after init
    }
  }
  backend "s3" {} # configured with -backend-config=envs/shared.backend.hcl (gitignored); key aws/shared/terraform.tfstate
}

provider "aws" {
  region = "us-east-1"
  default_tags {
    tags = {
      project    = "spoolspot"
      env        = "shared"
      owner      = "avi"
      managed-by = "opentofu"
      ticket     = "SPOOL-38"
    }
  }
}
