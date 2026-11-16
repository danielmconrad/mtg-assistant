# Cloudflare: the Worker's storage, the Access login in front of the browser routes, the zone's HTTPS
# settings, a WAF rule that blocks every path the Worker doesn't serve, and a coarse edge rate limit.
# The Worker itself is deployed by CI (wrangler deploy); its secrets are set by setup:secrets.

locals {
  routes = jsondecode(file("${path.module}/routes.json"))
  emails = [for email in split(",", var.allowed_emails) : trimspace(email) if trimspace(email) != ""]
  # A quoted string in Cloudflare's rules language, as in "/mcp".
  quote = { for value in concat([var.host], local.routes.public_paths, [local.routes.access_edge_prefix]) :
    value => "\"${replace(replace(value, "\\", "\\\\"), "\"", "\\\"")}\""
  }
  access_idp_id = (
    var.access_login == "google"
    ? one([for provider in data.cloudflare_zero_trust_access_identity_providers.all.result : provider.id if provider.type == "google"])
    : cloudflare_zero_trust_access_identity_provider.onetimepin[0].id
  )
}

# ---------------------------------------------------------------------------------------------
# Storage (IDs go into wrangler.jsonc: mise run infra:sync-wrangler)
# ---------------------------------------------------------------------------------------------

resource "cloudflare_d1_database" "main" {
  account_id = var.cloudflare_account_id
  name       = "mtg-assistant"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_workers_kv_namespace" "oauth" {
  account_id = var.cloudflare_account_id
  title      = "mtg-assistant-oauth"

  lifecycle {
    prevent_destroy = true
  }
}

# Uploaded collection files: private, with its r2.dev URL off and no custom domains.
resource "cloudflare_r2_bucket" "uploads" {
  account_id = var.cloudflare_account_id
  name       = "mtg-assistant-uploads"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_managed_domain" "uploads" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.uploads.name
  enabled     = false
}

# ---------------------------------------------------------------------------------------------
# Access: the login wall in front of /authorize, /callback, /download and /upload
# ---------------------------------------------------------------------------------------------

data "cloudflare_zero_trust_organization" "this" {
  account_id = var.cloudflare_account_id
}

# The Google login holds a client secret, so setup:secrets creates and updates it and it's only looked
# up here. Without one, Access's one-time PIN login (no secret) is managed here.
data "cloudflare_zero_trust_access_identity_providers" "all" {
  account_id = var.cloudflare_account_id
}

resource "cloudflare_zero_trust_access_identity_provider" "onetimepin" {
  count      = var.access_login == "onetimepin" ? 1 : 0
  account_id = var.cloudflare_account_id
  name       = "One-time PIN"
  type       = "onetimepin"
  config     = {}
}

resource "cloudflare_zero_trust_access_policy" "allowlist" {
  account_id       = var.cloudflare_account_id
  name             = "mtg-assistant allowlist"
  decision         = "allow"
  include          = [for email in local.emails : { email = { email = email } }]
  session_duration = "24h"
}

resource "cloudflare_zero_trust_access_application" "browser_routes" {
  account_id                 = var.cloudflare_account_id
  name                       = "mtg-assistant browser routes"
  type                       = "self_hosted"
  domain                     = "${var.host}${local.routes.access_paths[0]}"
  destinations               = [for path in local.routes.access_paths : { type = "public", uri = "${var.host}${path}" }]
  allowed_idps               = [local.access_idp_id]
  auto_redirect_to_identity  = true
  app_launcher_visible       = false
  session_duration           = "24h"
  http_only_cookie_attribute = true
  same_site_cookie_attribute = "lax"
  enable_binding_cookie      = true
  policies                   = [{ id = cloudflare_zero_trust_access_policy.allowlist.id, precedence = 1 }]

  lifecycle {
    precondition {
      condition     = local.access_idp_id != null
      error_message = "No Google login in Access yet: run mise run setup:secrets first, or leave ACCESS_GOOGLE_CLIENT_ID empty for one-time PIN."
    }
  }
}

# ---------------------------------------------------------------------------------------------
# The zone
# ---------------------------------------------------------------------------------------------

resource "cloudflare_zone_setting" "always_use_https" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "always_use_https"
  value      = "on"
}

resource "cloudflare_zone_setting" "min_tls_version" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "min_tls_version"
  value      = "1.2"
}

# A phase's entrypoint ruleset holds every rule in that phase for the zone, so these two own their
# phases: a rule added in the dashboard is removed on the next apply (the plan shows it first).

resource "cloudflare_ruleset" "waf" {
  zone_id = var.cloudflare_zone_id
  name    = "default"
  kind    = "zone"
  phase   = "http_request_firewall_custom"

  rules = [{
    ref         = "mtg-assistant-block-unknown-paths"
    description = "mtg-assistant: block every path the Worker does not serve"
    # Cloudflare Access answers its own endpoints (/cdn-cgi/access/...) on this host, after the WAF,
    # so they're let through; nothing else under /cdn-cgi/ is.
    expression = join("", [
      "(http.host eq ${local.quote[var.host]}",
      " and not (http.request.uri.path in {${join(" ", [for path in local.routes.public_paths : local.quote[path]])}})",
      " and not starts_with(http.request.uri.path, ${local.quote[local.routes.access_edge_prefix]}))",
    ])
    action  = "block"
    enabled = true
  }]
}

# The Free plan allows one rate limiting rule with a 10-second period; the Worker enforces the finer
# per-route limits itself.
resource "cloudflare_ruleset" "rate_limit" {
  zone_id = var.cloudflare_zone_id
  name    = "default"
  kind    = "zone"
  phase   = "http_ratelimit"

  rules = [{
    ref         = "mtg-assistant-edge-rate-limit"
    description = "mtg-assistant: coarse per-IP limit in front of the Worker"
    expression  = "(http.host eq ${local.quote[var.host]})"
    action      = "block"
    ratelimit = {
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = 10
      requests_per_period = 50
      mitigation_timeout  = 10
    }
    enabled = true
  }]
}
