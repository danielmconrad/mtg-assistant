# scripts/tofu.sh sets these from .env (TF_VAR_*), so the values live in one place.

variable "cloudflare_account_id" {
  type        = string
  description = "CLOUDFLARE_ACCOUNT_ID"
}

variable "cloudflare_zone_id" {
  type        = string
  description = "CLOUDFLARE_ZONE_ID: the zone the host is in"
}

variable "host" {
  type        = string
  description = "MTG_ASSISTANT_HOST: the hostname the Worker serves"
}

variable "allowed_emails" {
  type        = string
  description = "ALLOWED_EMAILS: lowercase emails, comma-separated, that the Access policy lets in"

  validation {
    condition = alltrue([
      for email in split(",", var.allowed_emails) :
      can(regex("^[^@\\sA-Z]+@[^@\\sA-Z]+\\.[^@\\sA-Z]+$", trimspace(email)))
    ])
    error_message = "ALLOWED_EMAILS must be lowercase emails separated by commas."
  }
}

variable "access_login" {
  type        = string
  description = "google when ACCESS_GOOGLE_CLIENT_ID is set (setup:secrets manages that login, since it holds a secret); otherwise onetimepin, managed here"

  validation {
    condition     = contains(["google", "onetimepin"], var.access_login)
    error_message = "access_login is google or onetimepin."
  }
}

variable "github_owner" {
  type        = string
  description = "The GitHub account that owns the repository"
}

variable "github_repository" {
  type        = string
  description = "The repository's name"
}

variable "deploy_enabled" {
  type        = bool
  default     = true
  description = "Sets the DEPLOY_ENABLED Actions variable that turns on deploys and the nightly ingest"
}

variable "state_passphrase" {
  type        = string
  sensitive   = true
  description = "TOFU_STATE_PASSPHRASE: encrypts state and plans before they leave this machine"

  validation {
    condition     = length(var.state_passphrase) >= 32
    error_message = "TOFU_STATE_PASSPHRASE must be at least 32 characters (openssl rand -base64 32)."
  }
}

variable "existing" {
  type = object({
    d1_database_id        = optional(string)
    kv_namespace_id       = optional(string)
    uploads_bucket        = optional(bool, false)
    zone_settings         = optional(bool, false)
    access_policy_id      = optional(string)
    access_application_id = optional(string)
    onetimepin_id         = optional(string)
    waf_ruleset_id        = optional(string)
    ratelimit_ruleset_id  = optional(string)
    github_environment    = optional(bool, false)
    deployment_policy_id  = optional(string)
    github_ruleset_id     = optional(string)
    github_variables      = optional(list(string), [])
  })
  default     = {}
  description = "Resources that already exist, to adopt into state on the next apply (imports.tf). mise run infra:adopt finds them and writes adopt.auto.tfvars.json"
}
