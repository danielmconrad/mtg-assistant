// Finds the Cloudflare and GitHub resources that already exist (made before OpenTofu managed them, by the
// old setup:accounts) and writes their IDs to infra/adopt.auto.tfvars.json, so the next infra:plan
// imports them into state rather than creating duplicates (infra/imports.tf). Only reads; run it with
// mise run infra:adopt, then mise run infra:plan.
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { cf, cfFind, ghApi, ghFind } from './accounts/api.mjs';
import { originRepo } from './tofu.mjs';

export const ADOPT_FILE = 'infra/adopt.auto.tfvars.json';
// The names infra/*.tf gives each resource.
export const NAMES = {
  d1: 'mtg-assistant',
  kv: 'mtg-assistant-oauth',
  bucket: 'mtg-assistant-uploads',
  accessPolicy: 'mtg-assistant allowlist',
  accessApp: 'mtg-assistant browser routes',
  githubRuleset: 'main: checks before merge',
  githubVariables: ['CLOUDFLARE_ACCOUNT_ID', 'DEPLOY_ENABLED'],
};

const byName = (list, field, name) => (list ?? []).find((item) => item[field] === name);
// An ID as OpenTofu's import IDs take it (GitHub's are numbers), or undefined when nothing was found.
const idOf = (item, field = 'id') => (item?.[field] === undefined ? undefined : String(item[field]));

// var.existing from what each lookup found; anything not found is left out, so OpenTofu creates it.
export function existingFrom(found) {
  const existing = {
    d1_database_id: idOf(found.d1, 'uuid'),
    kv_namespace_id: idOf(found.kv),
    uploads_bucket: Boolean(found.bucket),
    zone_settings: true,
    access_policy_id: idOf(found.accessPolicy),
    access_application_id: idOf(found.accessApp),
    onetimepin_id: idOf(found.onetimepin),
    waf_ruleset_id: idOf(found.wafRuleset),
    ratelimit_ruleset_id: idOf(found.rateLimitRuleset),
    github_environment: Boolean(found.environment),
    deployment_policy_id: idOf(found.deploymentPolicy),
    github_ruleset_id: idOf(found.githubRuleset),
    github_variables: (found.variables ?? []).filter((name) => NAMES.githubVariables.includes(name)),
  };
  return Object.fromEntries(Object.entries(existing).filter(([, value]) => value !== undefined));
}

async function lookUp(env) {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const zone = env.CLOUDFLARE_ZONE_ID;
  const repo = originRepo();
  const slug = `${repo.owner}/${repo.name}`;
  const [d1s, kvs, buckets, idps, policies, apps, waf, rateLimit] = await Promise.all([
    cf('GET', `/accounts/${account}/d1/database?name=${encodeURIComponent(NAMES.d1)}`),
    cf('GET', `/accounts/${account}/storage/kv/namespaces?per_page=100`),
    cf('GET', `/accounts/${account}/r2/buckets?name_contains=${encodeURIComponent(NAMES.bucket)}`),
    cf('GET', `/accounts/${account}/access/identity_providers`),
    cf('GET', `/accounts/${account}/access/policies`),
    cf('GET', `/accounts/${account}/access/apps`),
    cfFind(`/zones/${zone}/rulesets/phases/http_request_firewall_custom/entrypoint`),
    cfFind(`/zones/${zone}/rulesets/phases/http_ratelimit/entrypoint`),
  ]);
  const environment = ghFind(`/repos/${slug}/environments/production`);
  const policiesOnMain = environment
    ? ghApi('GET', `/repos/${slug}/environments/production/deployment-branch-policies`).branch_policies
    : [];
  return {
    d1: byName(d1s, 'name', NAMES.d1),
    kv: byName(kvs, 'title', NAMES.kv),
    bucket: byName(buckets?.buckets, 'name', NAMES.bucket),
    onetimepin: env.ACCESS_GOOGLE_CLIENT_ID?.trim() ? undefined : byName(idps, 'type', 'onetimepin'),
    accessPolicy: byName(policies, 'name', NAMES.accessPolicy),
    accessApp: byName(apps, 'name', NAMES.accessApp),
    wafRuleset: waf,
    rateLimitRuleset: rateLimit,
    environment,
    deploymentPolicy: byName(policiesOnMain, 'name', 'main'),
    githubRuleset: byName(ghApi('GET', `/repos/${slug}/rulesets`), 'name', NAMES.githubRuleset),
    variables: (ghApi('GET', `/repos/${slug}/actions/variables`).variables ?? []).map((variable) => variable.name),
  };
}

async function main() {
  const existing = existingFrom(await lookUp(process.env));
  await writeFile(ADOPT_FILE, `${JSON.stringify({ existing }, null, 2)}\n`);
  for (const [name, value] of Object.entries(existing)) console.log(`· ${name}: ${JSON.stringify(value)}`);
  console.log(`\nWrote ${ADOPT_FILE}. Next: mise run infra:plan, and check it imports these and changes little else.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
