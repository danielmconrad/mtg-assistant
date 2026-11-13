import { describe, expect, it } from 'vitest';
import { runChecks } from '../../scripts/post-deploy-check.mjs';

const ORIGIN = 'https://mtg-assistant.conrad.tools';
const ENV = { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'token' };
const SECURE = {
  'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
};

// A fake of the deployment as it should look; overrides change one answer.
function fakeDeployment(overrides = {}) {
  let registrations = 0;
  return async (input, init = {}) => {
    const url = new URL(input);
    const key = `${init.method ?? 'GET'} ${url.pathname}`;
    if (overrides[key]) return overrides[key]();
    if (url.hostname === 'api.cloudflare.com') {
      return Response.json({ result: { enabled: false, previews_enabled: false } });
    }
    if (key === 'GET /.well-known/oauth-authorization-server') {
      return Response.json({ issuer: ORIGIN }, { headers: SECURE });
    }
    if (key === 'POST /mcp') {
      return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="x"' } });
    }
    if (key === 'GET /authorize' || key === 'GET /callback') {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login' },
      });
    }
    if (key === 'GET /') return new Response(`<code class="url">${ORIGIN}/mcp</code>`, { headers: SECURE });
    if (key === 'POST /register') return new Response(null, { status: (registrations += 1) > 3 ? 429 : 400 });
    return new Response(null, { status: 403 });
  };
}

const noSleep = async () => {};

const run = async (overrides, fetchImpl = fakeDeployment(overrides)) => {
  const lines = [];
  const failed = await runChecks(ORIGIN, { fetchImpl, env: ENV, log: (line) => lines.push(line), sleep: noSleep });
  return { failed, lines };
};

// Fails to connect the first `failures` times, as a new custom domain does, then behaves normally.
function slowToStart(failures, fetchImpl = fakeDeployment()) {
  let attempts = 0;
  return async (input, init) => {
    attempts += 1;
    if (attempts <= failures) throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    return fetchImpl(input, init);
  };
}

describe('post-deploy checks', () => {
  it('pass against a correctly protected deployment', async () => {
    const { failed, lines } = await run();
    expect(lines.every((line) => line.startsWith('ok'))).toBe(true);
    expect(failed).toBe(0);
  });

  it.each([
    ['an open unknown path', { 'GET /admin': () => new Response('hello') }, 'unknown paths'],
    ['a blocked homepage', { 'GET /': () => new Response(null, { status: 403 }) }, 'homepage'],
    ['missing Access', { 'GET /authorize': () => new Response('consent') }, 'Access'],
    [
      'a WAF that blocks Access sign-ins',
      { 'GET /cdn-cgi/access/authorized': () => new Response('Sorry, you have been blocked', { status: 403 }) },
      'finish a sign-in',
    ],
    ['an unauthenticated /mcp', { 'POST /mcp': () => new Response('{}') }, '/mcp'],
    ['no rate limiting', { 'POST /register': () => new Response(null, { status: 400 }) }, 'rate limited'],
    [
      'workers.dev on',
      {
        'GET /client/v4/accounts/acct/workers/scripts/mtg-assistant/subdomain': () =>
          Response.json({ result: { enabled: true } }),
      },
      'workers.dev',
    ],
  ])('fail on %s', async (_label, overrides, check) => {
    const { failed, lines } = await run(overrides);
    expect(failed).toBe(1);
    expect(lines.find((line) => line.startsWith('FAIL'))).toContain(check);
  });

  it('waits for a new domain to come up, then runs every check', async () => {
    const { failed, lines } = await run(undefined, slowToStart(3));
    expect(failed).toBe(0);
    expect(lines.filter((line) => line.startsWith('...'))).toHaveLength(3);
  });

  it('fails once the domain never comes up', async () => {
    const { failed, lines } = await run(undefined, slowToStart(1000));
    expect(failed).toBe(1);
    expect(lines.at(-1)).toMatch(/^FAIL .* is reachable/);
  });

  it('does not retry an HTTP error: a wrong answer fails straight away', async () => {
    const { failed, lines } = await run({ 'POST /mcp': () => new Response('{}') });
    expect(failed).toBe(1);
    expect(lines.some((line) => line.startsWith('...'))).toBe(false);
  });

  it('says so when the Worker is in LOCKDOWN', async () => {
    const lockedDown = async () => new Response('Temporarily unavailable', { status: 503 });
    const { failed, lines } = await run(undefined, lockedDown);
    expect(failed).toBe(1);
    expect(lines).toEqual([expect.stringContaining('LOCKDOWN')]);
  });
});
