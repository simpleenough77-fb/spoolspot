# SPDX-License-Identifier: AGPL-3.0-or-later
terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0" # [U] pin the exact version resolved by `tofu init`; commit .terraform.lock.hcl
    }
  }
  backend "s3" {
    key = "bootstrap/terraform.tfstate"
  }
}

provider "aws" {
  region = "us-east-1"
  default_tags {
    tags = {
      project    = "spoolspot"
      env        = "shared"
      owner      = "avi"
      data-class = "restricted"
      managed-by = "opentofu"
      ticket     = "SPOOL-18"
    }
  }
}
