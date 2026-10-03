# SPDX-License-Identifier: AGPL-3.0-or-later
terraform {
  required_version = ">= 1.9.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0" # [U] pin exactly
    }
  }
  backend "s3" {} # key cloudflare/app/<env>/terraform.tfstate. prod: HUMAN APPLY ONLY.
}
provider "cloudflare" {}
