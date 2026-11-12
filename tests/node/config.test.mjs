// Invariants on the deploy configuration. Each one is a security property that a careless edit could
// silently remove, so CI fails instead.
import { readFile, readdir } from 'node:fs/promises';
import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';

const wrangler = parse(await readFile('wrangler.jsonc', 'utf8'));
const source = (
  await Promise.all(
    (await readdir('src', { recursive: true }))
      .filter((file) => file.endsWith('.mjs'))
      .map((file) => readFile(`src/${file}`, 'utf8')),
  )
).join('\n');
const SECRET_NAMES = [
  'ALLOWED_EMAILS',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_CLIENT_ID',
  'LOCKDOWN',
  'DEV_ACCESS_EMAIL',
  'DOWNLOAD_SIGNING_KEY',
  'UPLOAD_SIGNING_KEY',
];

describe('wrangler.jsonc', () => {
  it('serves only from the custom domain', () => {
    expect(wrangler.workers_dev).toBe(false);
    expect(wrangler.preview_urls).toBe(false);
    expect(wrangler.routes).toEqual([{ pattern: 'mtg-assistant.conrad.tools', custom_domain: true }]);
    expect(wrangler.vars.PUBLIC_ORIGIN).toBe('https://mtg-assistant.conrad.tools');
  });

  it('caps CPU time per request', () => {
    expect(wrangler.limits?.cpu_ms).toBeGreaterThan(0);
    expect(wrangler.limits.cpu_ms).toBeLessThanOrEqual(30_000);
  });

  it('keeps secrets and the dev Access bypass out of vars', () => {
    for (const name of SECRET_NAMES) expect(wrangler.vars, name).not.toHaveProperty(name);
  });

  it('only allows https redirect hosts that are Anthropic’s', () => {
    expect(wrangler.vars.ALLOWED_REDIRECT_HOSTS.split(',').sort()).toEqual(['claude.ai', 'claude.com']);
  });

  it('binds every rate limiter the code uses', () => {
    const used = new Set(source.match(/RL_[A-Z]+/g));
    const bound = new Set(wrangler.ratelimits.map((limiter) => limiter.name));
    expect([...used].filter((name) => !bound.has(name))).toEqual([]);
  });

  it('has no public R2 buckets or workers.dev-style escape hatches', () => {
    for (const bucket of wrangler.r2_buckets ?? []) expect(bucket).not.toHaveProperty('public');
    expect(wrangler).not.toHaveProperty('route');
    expect(JSON.stringify(wrangler)).not.toMatch(/workers\.dev/);
  });
});

describe('mise.toml', () => {
  it('stops wrangler loading .env or the process env into the Worker', async () => {
    const mise = await readFile('mise.toml', 'utf8');
    expect(mise).toMatch(/^CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false"$/m);
    expect(mise).toMatch(/^CLOUDFLARE_INCLUDE_PROCESS_ENV = "false"$/m);
  });

  it('lets only the dev task load secrets, and only from .env.worker', async () => {
    const mise = await readFile('mise.toml', 'utf8');
    expect(mise.match(/CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "true"/g)).toHaveLength(1);
    const devTask = mise.slice(mise.indexOf('[tasks.dev]'), mise.indexOf('[tasks.test]'));
    expect(devTask).toContain('CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "true"');
    expect(devTask).toContain('--env-file .env.worker ');
  });
});

describe('migrations', () => {
  it('are additive only, so a deploy can run them before the new code is live', async () => {
    const files = (await readdir('migrations')).filter((file) => file.endsWith('.sql'));
    for (const file of files) {
      const sql = (await readFile(`migrations/${file}`, 'utf8')).replace(/--.*$/gm, '');
      expect(sql, file).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX)\b|\bRENAME\b|\bDELETE\s+FROM\b/i);
    }
  });
});
