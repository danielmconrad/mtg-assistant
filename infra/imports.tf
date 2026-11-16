# Adopts resources that already exist (the ones setup:accounts made before OpenTofu), so the first
# apply takes them over instead of making duplicates. mise run infra:adopt looks them up, read-only,
# and writes their IDs to adopt.auto.tfvars.json (var.existing); each block below imports one when its
# ID is there. Once state holds a resource, its import does nothing, and the file can be deleted.

locals {
  # { name = { name = id } } for each ID var.existing has, so lookup(local.adopt, name, {}) is a
  # for_each that imports once, or not at all.
  adopt = {
    for name in [
      "d1_database_id", "kv_namespace_id", "access_policy_id", "access_application_id", "onetimepin_id",
      "waf_ruleset_id", "ratelimit_ruleset_id", "deployment_policy_id", "github_ruleset_id",
    ] : name => { (name) = var.existing[name] } if var.existing[name] != null
  }
  account_variables = {
    for name in var.existing.github_variables : name => name
    if contains(["CLOUDFLARE_ACCOUNT_ID", "DEPLOY_ENABLED"], name)
  }
}

import {
  for_each = lookup(local.adopt, "d1_database_id", {})
  to       = cloudflare_d1_database.main
  id       = "${var.cloudflare_account_id}/${each.value}"
}

import {
  for_each = lookup(local.adopt, "kv_namespace_id", {})
  to       = cloudflare_workers_kv_namespace.oauth
  id       = "${var.cloudflare_account_id}/${each.value}"
}

import {
  for_each = var.existing.uploads_bucket ? { bucket = "mtg-assistant-uploads" } : {}
  to       = cloudflare_r2_bucket.uploads
  id       = "${var.cloudflare_account_id}/${each.value}/default"
}

import {
  for_each = var.existing.zone_settings ? { always_use_https = true } : {}
  to       = cloudflare_zone_setting.always_use_https
  id       = "${var.cloudflare_zone_id}/${each.key}"
}

import {
  for_each = var.existing.zone_settings ? { min_tls_version = true } : {}
  to       = cloudflare_zone_setting.min_tls_version
  id       = "${var.cloudflare_zone_id}/${each.key}"
}

import {
  for_each = lookup(local.adopt, "access_policy_id", {})
  to       = cloudflare_zero_trust_access_policy.allowlist
  id       = "${var.cloudflare_account_id}/${each.value}"
}

import {
  for_each = lookup(local.adopt, "access_application_id", {})
  to       = cloudflare_zero_trust_access_application.browser_routes
  id       = "accounts/${var.cloudflare_account_id}/${each.value}"
}

import {
  for_each = var.access_login == "onetimepin" ? lookup(local.adopt, "onetimepin_id", {}) : {}
  to       = cloudflare_zero_trust_access_identity_provider.onetimepin[0]
  id       = "accounts/${var.cloudflare_account_id}/${each.value}"
}

import {
  for_each = lookup(local.adopt, "waf_ruleset_id", {})
  to       = cloudflare_ruleset.waf
  id       = "zones/${var.cloudflare_zone_id}/${each.value}"
}

import {
  for_each = lookup(local.adopt, "ratelimit_ruleset_id", {})
  to       = cloudflare_ruleset.rate_limit
  id       = "zones/${var.cloudflare_zone_id}/${each.value}"
}

import {
  for_each = var.existing.github_environment ? { production = true } : {}
  to       = github_repository_environment.production
  id       = "${var.github_repository}:${each.key}"
}

import {
  for_each = lookup(local.adopt, "deployment_policy_id", {})
  to       = github_repository_environment_deployment_policy.main
  id       = "${var.github_repository}:production:${each.value}"
}

import {
  for_each = lookup(local.adopt, "github_ruleset_id", {})
  to       = github_repository_ruleset.main
  id       = "${var.github_repository}:${each.value}"
}

import {
  for_each = { for name in values(local.account_variables) : name => name if name == "CLOUDFLARE_ACCOUNT_ID" }
  to       = github_actions_variable.cloudflare_account_id
  id       = "${var.github_repository}:${each.value}"
}

import {
  for_each = { for name in values(local.account_variables) : name => name if name == "DEPLOY_ENABLED" }
  to       = github_actions_variable.deploy_enabled
  id       = "${var.github_repository}:${each.value}"
}
