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
    if (key === 'POST /register') return new Response(null, { status: (registrations += 1) > 3 ? 429 : 400 });
    return new Response(null, { status: 403 });
  };
}

const run = async (overrides) => {
  const lines = [];
  const failed = await runChecks(ORIGIN, {
    fetchImpl: fakeDeployment(overrides),
    env: ENV,
    log: (line) => lines.push(line),
  });
  return { failed, lines };
};

describe('post-deploy checks', () => {
  it('pass against a correctly protected deployment', async () => {
    const { failed, lines } = await run();
    expect(lines.every((line) => line.startsWith('ok'))).toBe(true);
    expect(failed).toBe(0);
  });

  it.each([
    ['an open root path', { 'GET /': () => new Response('hello') }, 'unknown paths'],
    ['missing Access', { 'GET /authorize': () => new Response('consent') }, 'Access'],
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
});
