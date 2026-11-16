# Plans infra/ against mocked providers, so CI checks the rules and settings with no credentials.
# Run with mise run infra:check.

mock_provider "cloudflare" {
  mock_data "cloudflare_zero_trust_access_identity_providers" {
    defaults = {
      # Every attribute must be given; the ones this config doesn't read are null.
      result = [{
        id                      = "google-idp"
        type                    = "google"
        name                    = "Google"
        config                  = null
        read_only               = false
        saml_certificate_set    = null
        saml_certificate_set_id = null
        scim_config             = null
      }]
    }
  }
}

mock_provider "github" {}

variables {
  cloudflare_account_id = "0123456789abcdef0123456789abcdef"
  cloudflare_zone_id    = "fedcba9876543210fedcba9876543210"
  host                  = "mtg-assistant.conrad.tools"
  allowed_emails        = "daniel@example.com, second@example.com"
  access_login          = "google"
  github_owner          = "owner"
  github_repository     = "mtg-assistant"
  state_passphrase      = "a test passphrase of at least thirty-two characters"
  # Nothing to adopt, even after infra:adopt has written adopt.auto.tfvars.json: tests can't import.
  existing = {}
}

run "waf_allows_exactly_the_worker_paths" {
  command = plan

  assert {
    condition = cloudflare_ruleset.waf.rules[0].expression == join("", [
      "(http.host eq \"mtg-assistant.conrad.tools\"",
      " and not (http.request.uri.path in {\"/\" \"/.well-known/oauth-authorization-server\"",
      " \"/.well-known/oauth-protected-resource\" \"/.well-known/oauth-protected-resource/mcp\"",
      " \"/register\" \"/token\" \"/authorize\" \"/callback\" \"/download\" \"/upload\" \"/mcp\"})",
      " and not starts_with(http.request.uri.path, \"/cdn-cgi/access/\"))",
    ])
    error_message = "The WAF rule must block every path but the Worker's and Access's own"
  }

  assert {
    condition     = cloudflare_ruleset.waf.rules[0].action == "block" && cloudflare_ruleset.rate_limit.rules[0].ratelimit.period == 10
    error_message = "Both edge rules block, and the rate limit uses the Free plan's 10-second period"
  }
}

run "access_guards_only_browser_routes" {
  command = plan

  assert {
    condition = [for destination in cloudflare_zero_trust_access_application.browser_routes.destinations : destination.uri] == [
      "mtg-assistant.conrad.tools/authorize",
      "mtg-assistant.conrad.tools/callback",
      "mtg-assistant.conrad.tools/download",
      "mtg-assistant.conrad.tools/upload",
    ]
    error_message = "Access must sit in front of the browser routes only"
  }

  assert {
    condition     = cloudflare_zero_trust_access_application.browser_routes.allowed_idps == toset(["google-idp"])
    error_message = "The Google login setup:secrets made is the only way in"
  }

  assert {
    condition = [for rule in cloudflare_zero_trust_access_policy.allowlist.include : rule.email.email] == [
      "daniel@example.com", "second@example.com",
    ]
    error_message = "The Access policy allows exactly ALLOWED_EMAILS"
  }

  assert {
    condition     = length(cloudflare_zero_trust_access_identity_provider.onetimepin) == 0
    error_message = "No one-time PIN login alongside Google"
  }
}

run "one_time_pin_without_google" {
  command = plan

  variables {
    access_login = "onetimepin"
  }

  assert {
    condition     = length(cloudflare_zero_trust_access_identity_provider.onetimepin) == 1
    error_message = "Without Google, Access uses a one-time PIN login"
  }
}

run "uploads_bucket_stays_private" {
  command = plan

  assert {
    condition     = cloudflare_r2_managed_domain.uploads.enabled == false
    error_message = "The uploads bucket has no r2.dev URL"
  }
}

run "main_needs_passing_checks" {
  command = plan

  assert {
    condition = toset([for check in github_repository_ruleset.main.rules[0].required_status_checks[0].required_check : check.context]) == toset([
      "lint", "test", "scan",
    ])
    error_message = "lint, test and scan must pass before a merge"
  }
}

run "refuses_bad_emails" {
  command = plan

  variables {
    allowed_emails = "Daniel@Example.com"
  }

  expect_failures = [var.allowed_emails]
}
