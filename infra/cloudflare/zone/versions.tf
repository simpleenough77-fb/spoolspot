# SPDX-License-Identifier: AGPL-3.0-or-later
terraform {
  required_version = ">= 1.9.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0" # [U] pin exactly; v5 attribute names must be confirmed by `tofu validate` (finding F7)
    }
  }
  backend "s3" {} # key cloudflare/zone/<prod|nonprod>/terraform.tfstate. PROD ZONE: HUMAN APPLY ONLY with a 24h token.
}

# Token comes from the CLOUDFLARE_API_TOKEN environment variable. Never from a file in the repo.
provider "cloudflare" {}
