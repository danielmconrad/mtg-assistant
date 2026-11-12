// Drives the Worker the way Claude and a browser would: a cookie jar, a signed Cloudflare Access
// assertion, and mocked Google and Access endpoints. Only fakes; nothing leaves the test.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { vi } from 'vitest';
import worker from '../../src/index.mjs';

export const ORIGIN = env.PUBLIC_ORIGIN;
export const RESOURCE = `${ORIGIN}/mcp`;
export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const ACCESS_KID = 'test-access-key';

const accessKeys = await generateKeyPair('RS256', { extractable: true });
const accessJwk = { ...(await exportJWK(accessKeys.publicKey)), kid: ACCESS_KID, alg: 'RS256', use: 'sig' };

// A Cloudflare Access assertion as Access would sign it, for the given email.
export async function accessAssertion(
  email,
  { audience = env.ACCESS_AUD, issuer = `https://${env.ACCESS_TEAM_DOMAIN}`, key = accessKeys.privateKey } = {},
) {
  return new SignJWT({ email, type: 'app' })
    .setProtectedHeader({ alg: 'RS256', kid: ACCESS_KID })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(`access-${email}`)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

export const otherAccessKeys = await generateKeyPair('RS256', { extractable: true });

const encodeSegment = (value) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// An unsigned Google id_token: the Worker checks claims only, since it gets the token straight from Google.
export function googleIdToken(claims) {
  return `${encodeSegment({ alg: 'RS256', typ: 'JWT' })}.${encodeSegment(claims)}.signature`;
}

// Mocks outbound fetches: Access's signing keys and Google's token endpoint. googleClaims(nonce)
// returns the id_token claims Google would issue; return null to make the exchange fail.
export function mockOutbound({ googleClaims }) {
  const calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    calls.push(url.toString());
    if (url.toString() === `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [accessJwk] });
    }
    if (url.toString() === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(await new Response(init.body).text());
      const claims = googleClaims(body);
      if (!claims) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({ id_token: googleIdToken(claims), access_token: 'unused' });
    }
    throw new Error(`Unexpected outbound fetch in test: ${url}`);
  });
  return calls;
}

// Standard Google claims for an email; the nonce comes from the authorize redirect.
export const googleClaimsFor = (email, nonce, overrides = {}) => ({
  iss: 'https://accounts.google.com',
  aud: env.GOOGLE_CLIENT_ID,
  sub: `google-${email}`,
  email,
  email_verified: true,
  nonce,
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 300,
  ...overrides,
});

const randomOctet = () => crypto.getRandomValues(new Uint8Array(1))[0];

// Calls the Worker directly, with optional env overrides, and waits for its background work.
export async function call(path, init = {}, envOverrides = {}) {
  const ctx = createExecutionContext();
  // Each call comes from its own IP unless the test pins one, so per-IP rate limits don't leak between tests.
  const headers = new Headers(init.headers);
  if (!headers.has('CF-Connecting-IP')) {
    headers.set('CF-Connecting-IP', `10.${randomOctet()}.${randomOctet()}.${randomOctet()}`);
  }
  const request = new Request(new URL(path, ORIGIN), { redirect: 'manual', ...init, headers });
  const response = await worker.fetch(request, { ...env, ...envOverrides }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export class CookieJar {
  cookies = new Map();
  store(response) {
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(';');
      const [name, ...value] = pair.split('=');
      const expired = attributes.some((attribute) => /max-age=0/i.test(attribute.trim()));
      if (expired) this.cookies.delete(name.trim());
      else this.cookies.set(name.trim(), value.join('='));
    }
    return response;
  }
  header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

export async function pkcePair() {
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return { verifier, challenge };
}

export async function registerClient(redirectUris = [CLAUDE_CALLBACK], extra = {}) {
  return call('/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude',
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...extra,
    }),
  });
}

// Runs the whole browser flow for email and returns what each step produced. Options let a test
// change who signs in where: accessEmail (Cloudflare Access) and googleClaims (Google).
export async function authorize({
  email,
  accessEmail = email,
  googleOverrides = {},
  envOverrides = {},
  decision = 'approve',
}) {
  const google = { nonce: undefined };
  mockOutbound({ googleClaims: () => googleClaimsFor(email, google.nonce, googleOverrides) });
  const registered = await registerClient();
  const client = await registered.json();
  const pkce = await pkcePair();
  const jar = new CookieJar();
  const access = { 'Cf-Access-Jwt-Assertion': await accessAssertion(accessEmail) };
  const authorizeUrl = new URL('/authorize', ORIGIN);
  authorizeUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: CLAUDE_CALLBACK,
    scope: 'mcp',
    state: 'claude-state',
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    resource: RESOURCE,
  }).toString();

  const consent = jar.store(await call(authorizeUrl.pathname + authorizeUrl.search, { headers: access }, envOverrides));
  const consentHtml = await consent.text();
  const handle = consentHtml.match(/name="handle" value="([^"]+)"/)?.[1];
  const result = { client, pkce, jar, consent, consentHtml };
  if (!handle) return result;

  const form = new URLSearchParams({ handle, decision });
  const approved = jar.store(
    await call(
      '/authorize',
      {
        method: 'POST',
        headers: { ...access, Cookie: jar.header(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
      },
      envOverrides,
    ),
  );
  result.approved = approved;
  const googleUrl = new URL(approved.headers.get('Location'));
  if (googleUrl.origin !== 'https://accounts.google.com') return result;

  google.nonce = googleUrl.searchParams.get('nonce');
  const callbackUrl = `/callback?${new URLSearchParams({ code: 'google-code', state: googleUrl.searchParams.get('state') })}`;
  const callback = jar.store(await call(callbackUrl, { headers: { ...access, Cookie: jar.header() } }, envOverrides));
  result.callback = callback;
  return result;
}

export async function exchangeCode({ client, pkce, callback }) {
  const location = new URL(callback.headers.get('Location'));
  return call('/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: location.searchParams.get('code'),
      redirect_uri: CLAUDE_CALLBACK,
      client_id: client.client_id,
      code_verifier: pkce.verifier,
      resource: RESOURCE,
    }),
  });
}

// A signed-in user's access token, from the whole flow.
export async function signIn(email) {
  const flow = await authorize({ email });
  const tokens = await (await exchangeCode(flow)).json();
  return { ...flow, tokens };
}

export async function mcp(token, method, params = {}, envOverrides = {}) {
  return call(
    '/mcp',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    },
    envOverrides,
  );
}
