import { readFile } from 'node:fs/promises';
import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_EDGE_PREFIX,
  ACCESS_PATHS,
  PUBLIC_PATHS,
  blockUnknownPathsRule,
  edgeRateLimitRule,
  editWranglerConfig,
  mergeRules,
  rulesNeedUpdate,
  validateEnv,
} from '../../scripts/setup-accounts.mjs';
import { ROUTES, matchRoute } from '../../src/routes.mjs';

const HOST = 'mtg-assistant.conrad.tools';

describe('the WAF path allowlist', () => {
  it('lets through exactly the paths the Worker serves', () => {
    for (const path of PUBLIC_PATHS) expect(matchRoute(path), path).toBeTruthy();
    for (const route of ROUTES) expect(PUBLIC_PATHS, route.path).toContain(route.path);
  });

  it('puts Access only in front of browser routes', () => {
    expect(ACCESS_PATHS).toEqual(['/authorize', '/callback', '/download']);
    for (const path of ['/mcp', '/token', '/register']) expect(ACCESS_PATHS).not.toContain(path);
  });

  it('builds a block rule scoped to the host', () => {
    const rule = blockUnknownPathsRule(HOST);
    expect(rule.action).toBe('block');
    expect(rule.expression).toBe(
      `(http.host eq "${HOST}"` +
        ` and not (http.request.uri.path in {${PUBLIC_PATHS.map((path) => `"${path}"`).join(' ')}})` +
        ' and not starts_with(http.request.uri.path, "/cdn-cgi/access/"))',
    );
  });

  it('lets Cloudflare Access finish a sign-in, and nothing else under /cdn-cgi/', () => {
    // Access redirects the browser to /cdn-cgi/access/authorized on our host to set its cookie.
    expect(ACCESS_EDGE_PREFIX).toBe('/cdn-cgi/access/');
    expect(blockUnknownPathsRule(HOST).expression).not.toMatch(/"\/cdn-cgi\/"/);
  });

  it('escapes quotes in the host', () => {
    expect(blockUnknownPathsRule('a"b').expression).toContain('"a\\"b"');
  });
});

describe('mergeRules', () => {
  const foreign = {
    id: '1',
    ref: 'someone-elses-rule',
    expression: 'true',
    action: 'log',
    version: '3',
    last_updated: 'x',
  };
  const staleOurs = { id: '2', ref: 'mtg-assistant-block-unknown-paths', expression: 'old', action: 'block' };

  it('keeps other rules and replaces ours', () => {
    const merged = mergeRules([foreign, staleOurs], [blockUnknownPathsRule(HOST)]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual({ id: '1', ref: 'someone-elses-rule', expression: 'true', action: 'log' });
    expect(merged[1].expression).toContain(HOST);
  });

  it('knows when our rules are current', () => {
    const ours = [edgeRateLimitRule(HOST)];
    expect(rulesNeedUpdate([foreign], ours)).toBe(true);
    expect(rulesNeedUpdate([foreign, { ...ours[0], id: '9', version: '1' }], ours)).toBe(false);
  });
});

describe('editWranglerConfig', () => {
  it('fills in IDs and Access settings, keeping comments', async () => {
    const text = await readFile('wrangler.jsonc', 'utf8');
    const edited = editWranglerConfig(text, {
      d1Id: 'd1-uuid',
      kvId: 'kv-id',
      teamDomain: 'team.cloudflareaccess.com',
      accessAud: 'aud-tag',
    });
    const config = parse(edited);
    expect(config.d1_databases[0].database_id).toBe('d1-uuid');
    expect(config.kv_namespaces[0].id).toBe('kv-id');
    expect(config.vars.ACCESS_TEAM_DOMAIN).toBe('team.cloudflareaccess.com');
    expect(config.vars.ACCESS_AUD).toBe('aud-tag');
    expect(edited).toContain('// The custom domain is the only way in');
    expect(config.workers_dev).toBe(false);
  });
});

describe('validateEnv', () => {
  const good = {
    CLOUDFLARE_ACCOUNT_ID: 'a',
    CLOUDFLARE_API_TOKEN: 't',
    MTG_ASSISTANT_HOST: HOST,
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
