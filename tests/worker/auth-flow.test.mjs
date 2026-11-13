import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { activeUser } from '../../src/auth/users.mjs';
import {
  CLAUDE_CALLBACK,
  RESOURCE,
  accessAssertion,
  authorize,
  call,
  exchangeCode,
  mcp,
  mockOutbound,
  otherAccessKeys,
  signIn,
} from './helpers.mjs';

const DANIEL = 'daniel@example.com';
const SECOND = 'second@example.com';

const eventTypes = async () =>
  (await env.DB.prepare('SELECT type FROM auth_events ORDER BY id').all()).results.map((row) => row.type);

const toolText = async (response) => (await response.json()).result.content[0].text;

describe('the full sign-in flow', () => {
  it('signs in through Access and Google, then calls whoami', async () => {
    const flow = await authorize({ email: DANIEL });
    expect(flow.consent.status).toBe(200);
    expect(flow.consentHtml).toContain('claude.ai');
    expect(flow.approved.status).toBe(302);
    const google = new URL(flow.approved.headers.get('Location'));
    expect(google.origin).toBe('https://accounts.google.com');
    expect(google.searchParams.get('code_challenge_method')).toBe('S256');
    expect(google.searchParams.get('login_hint')).toBe(DANIEL);
    expect(google.searchParams.get('scope')).toBe('openid email');

    expect(flow.callback.status).toBe(302);
    const back = new URL(flow.callback.headers.get('Location'));
    expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(back.searchParams.get('state')).toBe('claude-state');

    const tokens = await (await exchangeCode(flow)).json();
    expect(tokens.token_type).toBe('bearer');
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.refresh_token).toBeTruthy();

    const whoami = await mcp(tokens.access_token, 'tools/call', { name: 'whoami', arguments: {} });
    expect(whoami.status).toBe(200);
    expect(await toolText(whoami)).toContain(DANIEL);
    expect(await eventTypes()).toContain('login_success');
  });

  it('lists the whoami tool', async () => {
    const { tokens } = await signIn(DANIEL);
    const list = await (await mcp(tokens.access_token, 'tools/list')).json();
    expect(list.result.tools.map((tool) => tool.name)).toContain('whoami');
  });

  it('lets a denied consent go back to the client as access_denied', async () => {
    const flow = await authorize({ email: DANIEL, decision: 'deny' });
    const back = new URL(flow.approved.headers.get('Location'));
    expect(back.searchParams.get('error')).toBe('access_denied');
  });
});

describe('who gets in', () => {
  it('refuses /authorize without an Access assertion', async () => {
    mockOutbound({ googleClaims: () => null });
    const response = await call('/authorize?client_id=x');
    expect(response.status).toBe(403);
    expect(await eventTypes()).toContain('access_denied');
  });

  it('refuses an Access assertion signed by another key, for another audience or issuer', async () => {
    mockOutbound({ googleClaims: () => null });
    for (const assertion of [
      await accessAssertion(DANIEL, { key: otherAccessKeys.privateKey }),
      await accessAssertion(DANIEL, { audience: 'another-app' }),
      await accessAssertion(DANIEL, { issuer: 'https://evil.cloudflareaccess.com' }),
    ]) {
      const response = await call('/authorize?client_id=x', { headers: { 'Cf-Access-Jwt-Assertion': assertion } });
      expect(response.status).toBe(403);
    }
  });

  it('refuses an Access identity that is not allowlisted', async () => {
    const flow = await authorize({ email: 'stranger@example.com' });
    expect(flow.consent.status).toBe(403);
  });

  it('refuses a Google account that is not allowlisted', async () => {
    const flow = await authorize({ email: 'stranger@example.com', accessEmail: DANIEL });
    expect(flow.callback.status).toBe(403);
    expect(await eventTypes()).toContain('email_denied');
  });

  it('refuses a Google account that is not the Access identity', async () => {
    const flow = await authorize({ email: SECOND, accessEmail: DANIEL });
    expect(flow.callback.status).toBe(403);
    expect(await eventTypes()).toContain('identity_mismatch');
  });

  it('refuses unverified emails, wrong audiences, stale tokens and bad nonces from Google', async () => {
    for (const googleOverrides of [
      { email_verified: false },
      { aud: 'someone-else' },
      { exp: Math.floor(Date.now() / 1000) - 600 },
      { nonce: 'replayed-nonce' },
      { iss: 'https://evil.example' },
    ]) {
      const flow = await authorize({ email: DANIEL, googleOverrides });
      expect(flow.callback.status, JSON.stringify(googleOverrides)).toBe(403);
    }
  });

  it('pins the Google account: a different Google subject for the same email is refused', async () => {
    await signIn(DANIEL);
    const flow = await authorize({ email: DANIEL, googleOverrides: { sub: 'google-someone-else' } });
    expect(flow.callback.status).toBe(403);
  });

  it('refuses consent for a client whose redirect host left the allowlist', async () => {
    const flow = await authorize({ email: DANIEL, envOverrides: { ALLOWED_REDIRECT_HOSTS: 'claude.com' } });
    expect(flow.consent.status).toBe(403);
    expect(await eventTypes()).toContain('redirect_refused');
  });
});

describe('tokens', () => {
  it('refuses a replayed authorization code', async () => {
    const flow = await authorize({ email: DANIEL });
    expect((await exchangeCode(flow)).status).toBe(200);
    const replay = await exchangeCode(flow);
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe('invalid_grant');
  });

  it('refuses a code exchange with the wrong PKCE verifier', async () => {
    const flow = await authorize({ email: DANIEL });
    const response = await exchangeCode({
      ...flow,
      pkce: { verifier: 'wrong-verifier-wrong-verifier-wrong-verifier-123' },
    });
    expect(response.status).toBe(400);
  });

  it('rotates refresh tokens and refuses an old one once its replacement is used', async () => {
    const { client, tokens } = await signIn(DANIEL);
    const refresh = (refreshToken) =>
      call('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: client.client_id,
          resource: RESOURCE,
        }),
      });
    const first = await refresh(tokens.refresh_token);
    expect(first.status).toBe(200);
    const rotated = await first.json();
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    // The previous token stays valid only until its replacement is first used (for lost responses).
    expect((await refresh(rotated.refresh_token)).status).toBe(200);
    const reused = await refresh(tokens.refresh_token);
    expect(reused.status).toBe(400);
    expect((await reused.json()).error).toBe('invalid_grant');
  });

  it('stops working as soon as the email leaves ALLOWED_EMAILS', async () => {
    const { tokens } = await signIn(DANIEL);
    const response = await mcp(tokens.access_token, 'tools/list', {}, { ALLOWED_EMAILS: SECOND });
    expect(response.status).toBe(401);
    expect(await eventTypes()).toContain('token_refused');
  });

  it('stops working as soon as the user is disabled', async () => {
    const { tokens } = await signIn(DANIEL);
    await env.DB.prepare('UPDATE users SET disabled = 1 WHERE email = ?').bind(DANIEL).run();
    expect((await mcp(tokens.access_token, 'tools/list')).status).toBe(401);
  });

  it('keeps users apart: each token answers as its own user', async () => {
    const daniel = await signIn(DANIEL);
    const second = await signIn(SECOND);
    const asDaniel = await toolText(
      await mcp(daniel.tokens.access_token, 'tools/call', { name: 'whoami', arguments: {} }),
    );
    const asSecond = await toolText(
      await mcp(second.tokens.access_token, 'tools/call', { name: 'whoami', arguments: {} }),
    );
    expect(asDaniel).toContain(DANIEL);
    expect(asDaniel).not.toContain(SECOND);
    expect(asSecond).toContain(SECOND);
  });
});

describe('reserved accounts', () => {
  const reserve = (email, id = crypto.randomUUID()) =>
    env.DB.prepare(
      "INSERT INTO users (id, email, google_sub, pending, created_at, last_login_at) VALUES (?, ?, ?, 1, 'then', 'then')",
    )
      .bind(id, email, `pending:${id}`)
      .run()
      .then(() => id);

  it('are claimed by the first sign-in with their email, keeping their ID', async () => {
    const id = await reserve(SECOND);
    const { tokens } = await signIn(SECOND);
    expect(await toolText(await mcp(tokens.access_token, 'tools/call', { name: 'whoami', arguments: {} }))).toContain(
      SECOND,
    );
    const user = await env.DB.prepare('SELECT id, google_sub, pending FROM users WHERE email = ?').bind(SECOND).first();
    expect(user).toEqual({ id, google_sub: `google-${SECOND}`, pending: 0 });
    expect(await eventTypes()).toContain('account_claimed');
  });

  it('are pinned once claimed: a different Google account is refused afterwards', async () => {
    await reserve(SECOND);
    await signIn(SECOND);
    const flow = await authorize({ email: SECOND, googleOverrides: { sub: 'google-someone-else' } });
    expect(flow.callback.status).toBe(403);
  });

  it('cannot be claimed by a Google account that already has an account', async () => {
    await signIn(DANIEL);
    await reserve(SECOND);
    const flow = await authorize({ email: SECOND, googleOverrides: { sub: `google-${DANIEL}` } });
    expect(flow.callback.status).toBe(403);
    const user = await env.DB.prepare('SELECT pending FROM users WHERE email = ?').bind(SECOND).first();
    expect(user.pending).toBe(1);
  });

  it('give no access while still pending, even with the placeholder identity', async () => {
    const id = await reserve(SECOND);
    expect(await activeUser(env.DB, { userId: id, email: SECOND, sub: `pending:${id}` })).toBeNull();
  });
});
