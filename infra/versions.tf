# Everything this project needs in Cloudflare and GitHub, except secret values (scripts/setup-secrets.mjs
# pushes those, so none is ever written to state). Run it from a laptop only, through mise:
#
#   mise run infra:plan    # what would change
#   mise run infra:apply   # show the plan, then apply it once you confirm
#
# State lives in the private R2 bucket mtg-assistant-tfstate (mise run infra:bootstrap creates it),
# encrypted on this machine before upload with TOFU_STATE_PASSPHRASE, so Cloudflare holds only ciphertext.
terraform {
  required_version = "~> 1.13.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.28.1"
    }
    github = {
      source  = "integrations/github"
      version = "6.13.0"
    }
  }

  # R2 speaks S3. Credentials are an R2 API token's access key pair (AWS_ACCESS_KEY_ID and
  # AWS_SECRET_ACCESS_KEY, mapped from .env by scripts/tofu.sh).
  backend "s3" {
    bucket                      = "mtg-assistant-tfstate"
    key                         = "infra.tfstate"
    region                      = "auto"
    endpoints                   = { s3 = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com" }
    use_path_style              = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }

  encryption {
    key_provider "pbkdf2" "state" {
      passphrase = var.state_passphrase
    }
    method "aes_gcm" "state" {
      keys = key_provider.pbkdf2.state
    }
    state {
      method   = method.aes_gcm.state
      enforced = true
    }
    plan {
      method   = method.aes_gcm.state
      enforced = true
    }
  }
}

# CLOUDFLARE_API_TOKEN (the admin token in .env) authenticates.
provider "cloudflare" {}

# GITHUB_TOKEN (GH_TOKEN from .env) authenticates.
provider "github" {
  owner = var.github_owner
}
