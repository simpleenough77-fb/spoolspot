# SPDX-License-Identifier: AGPL-3.0-or-later
terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0" # [U] pin exactly after init
    }
  }
  backend "s3" {} # key aws/identity/<env>/terraform.tfstate
}

provider "aws" {
  region = "us-east-1"
  default_tags {
    tags = {
      project    = "spoolspot"
      env        = var.env
      owner      = "avi"
      data-class = "confidential"
      managed-by = "opentofu"
      ticket     = "SPOOL-47"
    }
  }
}
