# GitHub: the production environment deploys run in (main only), the ruleset that makes every change
# to main a pull request with passing checks, and the Actions variables CI reads. Actions secrets,
# Dependabot and secret scanning are set by setup:secrets.

locals {
  # The CI jobs that must pass before a merge (.github/workflows/ci.yml).
  required_checks = ["lint", "test", "scan"]
}

resource "github_repository_environment" "production" {
  repository  = var.github_repository
  environment = "production"

  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }
}

resource "github_repository_environment_deployment_policy" "main" {
  repository     = var.github_repository
  environment    = github_repository_environment.production.environment
  branch_pattern = "main"
}

resource "github_repository_ruleset" "main" {
  repository  = var.github_repository
  name        = "main: checks before merge"
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["~DEFAULT_BRANCH"]
      exclude = []
    }
  }

  rules {
    deletion         = true
    non_fast_forward = true

    pull_request {
      required_approving_review_count   = 0
      dismiss_stale_reviews_on_push     = false
      require_code_owner_review         = false
      require_last_push_approval        = false
      required_review_thread_resolution = false
    }

    required_status_checks {
      strict_required_status_checks_policy = false

      dynamic "required_check" {
        for_each = local.required_checks
        content {
          context = required_check.value
        }
      }
    }
  }
}

resource "github_actions_variable" "cloudflare_account_id" {
  repository    = var.github_repository
  variable_name = "CLOUDFLARE_ACCOUNT_ID"
  value         = var.cloudflare_account_id
}

# Deploys and the nightly ingest start only once this is true.
resource "github_actions_variable" "deploy_enabled" {
  repository    = var.github_repository
  variable_name = "DEPLOY_ENABLED"
  value         = tostring(var.deploy_enabled)
}
