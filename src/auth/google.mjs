// Google sign-in (OpenID Connect authorization code flow with PKCE and a nonce). Google is only the
// identity step: the server keeps no Google tokens and calls no Google APIs.

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const CLOCK_SKEW_SECONDS = 60;

const base64Url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export const randomToken = () => base64Url(crypto.getRandomValues(new Uint8Array(32)));

export async function s256(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export const redirectUri = (config) => `${config.origin}/callback`;

export function authorizeUrl(env, config, { state, codeChallenge, nonce, loginHint }) {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(config),
    response_type: 'code',
    scope: 'openid email',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
    ...(loginHint && { login_hint: loginHint }),
  }).toString();
  return url.toString();
}

function decodeJwtPayload(jwt) {
  const parts = String(jwt).split('.');
  if (parts.length !== 3) throw new Error('malformed id_token');
  const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(json);
}

// Checks the ID token's claims. Its signature isn't checked: the token comes straight from Google's
// token endpoint over TLS in exchange for our client secret, which OpenID Connect Core 3.1.3.7 accepts
// in place of signature validation.
export function checkIdTokenClaims(claims, { clientId, nonce, now = Date.now() / 1000 }) {
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const checks = [
    ['unexpected issuer', () => ISSUERS.has(claims.iss)],
    ['wrong audience', () => audiences.includes(clientId)],
    ['wrong authorized party', () => audiences.length < 2 || claims.azp === clientId],
    ['expired', () => typeof claims.exp === 'number' && claims.exp + CLOCK_SKEW_SECONDS >= now],
    ['issued in the future', () => typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_SECONDS <= now],
    ['nonce mismatch', () => claims.nonce === nonce],
    ['missing subject', () => typeof claims.sub === 'string' && claims.sub !== ''],
    ['email not verified', () => claims.email_verified === true],
    ['missing email', () => typeof claims.email === 'string' && claims.email !== ''],
  ];
  return checks.find(([, passes]) => !passes())?.[0] ?? null;
}

// Exchanges the authorization code and returns { sub, email } or { problem }.
export async function exchangeCode(env, config, { code, verifier, nonce }) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(config),
    }),
  });
  if (!response.ok) return { problem: `Google token exchange failed (${response.status})` };
  const body = await response.json();
  let claims;
  try {
    claims = decodeJwtPayload(body.id_token);
  } catch {
    return { problem: 'Google returned no usable id_token' };
  }
  const problem = checkIdTokenClaims(claims, { clientId: env.GOOGLE_CLIENT_ID, nonce });
  if (problem) return { problem: `Google id_token rejected: ${problem}` };
  return { sub: claims.sub, email: claims.email.toLowerCase() };
}
