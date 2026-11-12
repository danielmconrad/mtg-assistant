import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CLAUDE_CALLBACK, ORIGIN, RESOURCE, call, registerClient } from './helpers.mjs';

const events = async (type) =>
  (await env.DB.prepare('SELECT * FROM auth_events WHERE type = ? ORDER BY id').bind(type).all()).results;

describe('route allowlist', () => {
  it('404s paths outside the route map', async () => {
    for (const path of ['/', '/admin', '/.env', '/mcp/../admin', '/wp-login.php', '/upload']) {
      expect((await call(path)).status, path).toBe(404);
    }
  });

  it('405s methods a route does not take', async () => {
    expect((await call('/token')).status).toBe(405);
    expect((await call('/register')).status).toBe(405);
    expect((await call('/callback', { method: 'POST' })).status).toBe(405);
  });

  it('serves OAuth discovery metadata', async () => {
    const server = await (await call('/.well-known/oauth-authorization-server')).json();
    expect(server.issuer).toBe(ORIGIN);
    expect(server.code_challenge_methods_supported).toEqual(['S256']);
    expect(server.registration_endpoint).toBe(`${ORIGIN}/register`);
    const resource = await (await call('/.well-known/oauth-protected-resource/mcp')).json();
    expect(resource.resource).toBe(RESOURCE);
    expect(resource.authorization_servers).toEqual([ORIGIN]);
  });

  it('challenges /mcp without a token', async () => {
    const response = await call('/mcp', { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('resource_metadata=');
  });

  it('rejects a forged bearer token', async () => {
    const response = await call('/mcp', {
      method: 'POST',
      body: '{}',
      headers: { Authorization: 'Bearer abc:def:ghi' },
    });
    expect(response.status).toBe(401);
  });
});

describe('CORS preflights', () => {
  it('answers preflights for the routes browser-based clients call', async () => {
    for (const [path, method] of [
      ['/register', 'POST'],
      ['/token', 'POST'],
      ['/mcp', 'POST'],
      ['/.well-known/oauth-authorization-server', 'GET'],
      ['/.well-known/oauth-protected-resource/mcp', 'GET'],
    ]) {
      const response = await call(path, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:6274',
          'Access-Control-Request-Method': method,
          'Access-Control-Request-Headers': 'content-type, authorization, mcp-protocol-version',
        },
      });
      expect(response.status, path).toBeLessThan(300);
      expect(response.headers.get('Access-Control-Allow-Origin'), path).toBeTruthy();
    }
  });

  it('still refuses OPTIONS on the browser-only routes', async () => {
    expect((await call('/authorize', { method: 'OPTIONS' })).status).toBe(405);
    expect((await call('/callback', { method: 'OPTIONS' })).status).toBe(405);
  });
});

describe('security headers', () => {
  it('sets HSTS, nosniff, no-referrer and no-store on every response', async () => {
    for (const path of ['/nope', '/.well-known/oauth-authorization-server']) {
      const response = await call(path);
      expect(response.headers.get('Strict-Transport-Security')).toContain('max-age=63072000');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(response.headers.get('Cache-Control')).toContain('no-store');
    }
  });

  it('puts a strict CSP on HTML pages', async () => {
    const response = await call('/authorize');
    expect(response.headers.get('Content-Type')).toContain('text/html');
    const csp = response.headers.get('Content-Security-Policy');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });
});

describe('lockdown', () => {
  it('answers 503 everywhere when LOCKDOWN=1', async () => {
    for (const path of ['/mcp', '/authorize', '/token', '/.well-known/oauth-authorization-server']) {
      expect((await call(path, {}, { LOCKDOWN: '1' })).status, path).toBe(503);
    }
  });
});

describe('rate limits', () => {
  it('limits /register per IP', async () => {
    const statuses = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await call('/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' },
        body: JSON.stringify({ client_name: 'x', redirect_uris: ['https://evil.example/cb'] }),
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 3).every((status) => status !== 429)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('client registration', () => {
  it('accepts claude.ai and loopback redirect URIs', async () => {
    expect((await registerClient([CLAUDE_CALLBACK])).status).toBe(201);
    expect((await registerClient(['http://localhost:33418/callback'])).status).toBe(201);
    expect((await registerClient(['http://127.0.0.1:8080/cb'])).status).toBe(201);
  });

  it('refuses other redirect URIs and logs them', async () => {
    for (const uris of [
      ['https://evil.example/callback'],
      [CLAUDE_CALLBACK, 'https://evil.example/callback'],
      ['https://claude.ai.evil.example/cb'],
      ['http://claude.ai/api/mcp/auth_callback'],
      ['https://user:pass@claude.ai/cb'],
    ]) {
      const response = await registerClient(uris);
      expect(response.status, uris.join()).toBe(400);
    }
    // Remote http and userinfo URIs fail the library's own validation before our policy runs; the
    // policy logs the three that reached it.
    const logged = (await events('registration_refused')).map((event) => JSON.parse(event.detail).refused);
    expect(logged).toEqual([
      ['https://evil.example/callback'],
      ['https://evil.example/callback'],
      ['https://claude.ai.evil.example/cb'],
    ]);
  });

  it('keeps registration open past the alert threshold, flagging it instead of refusing', async () => {
    const statuses = [];
    for (let index = 0; index < 7; index += 1) statuses.push((await registerClient()).status);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 201, 201]);
    // OAUTH_CLIENT_ALERT_THRESHOLD is 5 in tests: the 6th and 7th registrations are flagged.
    expect(await events('client_count_high')).toHaveLength(2);
  });

  it('gives registered clients a finite lifetime', async () => {
    const { client_id: clientId } = await (await registerClient()).json();
    const { keys } = await env.OAUTH_KV.list({ prefix: `client:${clientId}` });
    const lifetime = keys[0].expiration - Date.now() / 1000;
    expect(lifetime).toBeGreaterThan(60 * 24 * 60 * 60 - 120);
    expect(lifetime).toBeLessThanOrEqual(60 * 24 * 60 * 60);
  });
});
