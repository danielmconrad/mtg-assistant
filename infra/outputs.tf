# What wrangler.jsonc needs (mise run infra:sync-wrangler writes them in). None is secret.

output "d1_database_id" {
  value = cloudflare_d1_database.main.id
}

output "kv_namespace_id" {
  value = cloudflare_workers_kv_namespace.oauth.id
}

output "access_team_domain" {
  value = data.cloudflare_zero_trust_organization.this.auth_domain
}

output "access_aud" {
  value = cloudflare_zero_trust_access_application.browser_routes.aud
}
