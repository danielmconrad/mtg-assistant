// The account scripts' pure parts, and the route lists infra/ builds the WAF and Access rules from.
// infra/tests/infra.tftest.hcl checks the rules themselves (mise run infra:check).
import { readFile } from 'node:fs/promises';
import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { existingFrom } from '../../scripts/infra-adopt.mjs';
import { validateEnv } from '../../scripts/setup-secrets.mjs';
import { editWranglerConfig, valuesFromOutputs } from '../../scripts/sync-wrangler.mjs';
import { REQUIRED, githubRepo, tofuEnv } from '../../scripts/tofu.mjs';
import { ROUTES, matchRoute } from '../../src/routes.mjs';

const routes = JSON.parse(await readFile('infra/routes.json', 'utf8'));

describe('the WAF path allowlist (infra/routes.json)', () => {
  it('lets through exactly the paths the Worker serves', () => {
    for (const path of routes.public_paths) expect(matchRoute(path), path).toBeTruthy();
    for (const route of ROUTES) expect(routes.public_paths, route.path).toContain(route.path);
  });

  it('puts Access only in front of browser routes', () => {
    expect(routes.access_paths).toEqual(['/authorize', '/callback', '/download', '/upload']);
    for (const path of ['/mcp', '/token', '/register']) expect(routes.access_paths).not.toContain(path);
  });

  it('lets Cloudflare Access finish a sign-in, and nothing else under /cdn-cgi/', () => {
    // Access redirects the browser to /cdn-cgi/access/authorized on our host to set its cookie.
    expect(routes.access_edge_prefix).toBe('/cdn-cgi/access/');
  });
});

describe('tofuEnv', () => {
  const env = Object.fromEntries(REQUIRED.map((name) => [name, `${name.toLowerCase()}-value`]));
  const repo = { owner: 'danielmconrad', name: 'mtg-assistant' };

  it('passes .env to OpenTofu, its backend and its providers', () => {
    expect(tofuEnv(env, repo)).toMatchObject({
      TF_VAR_cloudflare_account_id: 'cloudflare_account_id-value',
      TF_VAR_host: 'mtg_assistant_host-value',
      TF_VAR_access_login: 'onetimepin',
      TF_VAR_github_owner: 'danielmconrad',
      TF_VAR_github_repository: 'mtg-assistant',
      TF_VAR_state_passphrase: 'tofu_state_passphrase-value',
      AWS_ACCESS_KEY_ID: 'tofu_state_access_key_id-value',
      AWS_SECRET_ACCESS_KEY: 'tofu_state_secret_access_key-value',
      GITHUB_TOKEN: 'gh_token-value',
    });
    expect(tofuEnv({ ...env, ACCESS_GOOGLE_CLIENT_ID: 'id' }, repo).TF_VAR_access_login).toBe('google');
  });

  it('names what .env is missing', () => {
    expect(() => tofuEnv({ ...env, TOFU_STATE_PASSPHRASE: ' ' }, repo)).toThrow(/TOFU_STATE_PASSPHRASE/);
  });

  it('reads the repository from origin', () => {
    expect(githubRepo('git@github.com:danielmconrad/mtg-assistant.git')).toEqual(repo);
    expect(githubRepo('https://github.com/danielmconrad/mtg-assistant')).toEqual(repo);
    expect(() => githubRepo('https://gitlab.com/x/y')).toThrow(/not a GitHub repository/);
  });
});

describe('existingFrom', () => {
  it('adopts what was found and leaves the rest for OpenTofu to create', () => {
    expect(
      existingFrom({
        d1: { uuid: 'd1-uuid' },
        kv: { id: 'kv-id' },
        bucket: { name: 'mtg-assistant-uploads' },
        accessApp: { id: 'app-id' },
        wafRuleset: { id: 'waf-id' },
        environment: { name: 'production' },
        deploymentPolicy: { id: 7, name: 'main' },
        githubRuleset: { id: 42 },
        variables: ['CLOUDFLARE_ACCOUNT_ID', 'SOMETHING_ELSE'],
      }),
    ).toEqual({
      d1_database_id: 'd1-uuid',
      kv_namespace_id: 'kv-id',
      uploads_bucket: true,
      zone_settings: true,
      access_application_id: 'app-id',
      waf_ruleset_id: 'waf-id',
      github_environment: true,
      deployment_policy_id: '7',
      github_ruleset_id: '42',
      github_variables: ['CLOUDFLARE_ACCOUNT_ID'],
    });
  });
});

describe('editWranglerConfig', () => {
  it('fills in IDs and Access settings from OpenTofu’s outputs, keeping comments', async () => {
    const text = await readFile('wrangler.jsonc', 'utf8');
    const values = valuesFromOutputs({
      d1_database_id: { value: 'd1-uuid' },
      kv_namespace_id: { value: 'kv-id' },
      access_team_domain: { value: 'team.cloudflareaccess.com' },
      access_aud: { value: 'aud-tag' },
    });
    const config = parse(editWranglerConfig(text, values));
    expect(config.d1_databases[0].database_id).toBe('d1-uuid');
    expect(config.kv_namespaces[0].id).toBe('kv-id');
    expect(config.vars.ACCESS_TEAM_DOMAIN).toBe('team.cloudflareaccess.com');
    expect(config.vars.ACCESS_AUD).toBe('aud-tag');
    expect(editWranglerConfig(text, values)).toContain('// The custom domain is the only way in');
    expect(config.workers_dev).toBe(false);
  });
});

describe('validateEnv', () => {
  const good = {
    CLOUDFLARE_ACCOUNT_ID: 'a',
    CLOUDFLARE_API_TOKEN: 't',
    GOOGLE_CLIENT_ID: 'g',
    GOOGLE_CLIENT_SECRET: 's',
    ALLOWED_EMAILS: 'daniel@example.com',
    GH_TOKEN: 'gh',
  };

  it('accepts a complete .env', () => expect(validateEnv(good)).toEqual([]));
  it('names empty values', () => expect(validateEnv({ ...good, GH_TOKEN: ' ' })).toEqual(['GH_TOKEN is empty']));
  it('rejects badly formed emails', () => {
    expect(validateEnv({ ...good, ALLOWED_EMAILS: 'Daniel@Example.com' })).toHaveLength(1);
    expect(validateEnv({ ...good, ALLOWED_EMAILS: 'daniel@example.com; second@example.com' })).toHaveLength(1);
  });
  it('wants both Access Google values or neither', () => {
    expect(validateEnv({ ...good, ACCESS_GOOGLE_CLIENT_ID: 'x' })).toHaveLength(1);
  });
});
