import { describe, expect, it } from 'vitest';
import { checkIdTokenClaims } from '../../src/auth/google.mjs';
import { isAllowedEmail, isAllowedRedirectUri, readConfig } from '../../src/config.mjs';

const config = readConfig({
  PUBLIC_ORIGIN: 'https://mtg-assistant.conrad.tools',
  ALLOWED_EMAILS: ' Daniel@Example.com ,second@example.com',
  ALLOWED_REDIRECT_HOSTS: 'claude.ai,claude.com',
});

describe('readConfig', () => {
  it('refuses a non-https origin outside loopback', () => {
    expect(() => readConfig({ PUBLIC_ORIGIN: 'http://mtg-assistant.conrad.tools' })).toThrow();
  });

  it('ignores DEV_ACCESS_EMAIL unless the origin is loopback', () => {
    expect(
      readConfig({ PUBLIC_ORIGIN: 'https://mtg-assistant.conrad.tools', DEV_ACCESS_EMAIL: 'a@b.c' }).devAccessEmail,
    ).toBe('');
    expect(readConfig({ PUBLIC_ORIGIN: 'http://localhost:8787', DEV_ACCESS_EMAIL: 'a@b.c' }).devAccessEmail).toBe(
      'a@b.c',
    );
  });
});

describe('isAllowedEmail', () => {
  it('matches exactly, ignoring case and spaces', () => {
    expect(isAllowedEmail(config, 'daniel@example.com')).toBe(true);
    expect(isAllowedEmail(config, 'DANIEL@example.com')).toBe(true);
    expect(isAllowedEmail(config, 'daniel@example.com.evil')).toBe(false);
    expect(isAllowedEmail(config, 'xdaniel@example.com')).toBe(false);
    expect(isAllowedEmail(config, undefined)).toBe(false);
  });
});

describe('isAllowedRedirectUri', () => {
  it.each([
    ['https://claude.ai/api/mcp/auth_callback', true],
    ['https://claude.com/api/mcp/auth_callback', true],
    ['http://localhost:4000/callback', true],
    ['http://127.0.0.1:4000/callback', true],
    ['http://claude.ai/api/mcp/auth_callback', false],
    ['https://claude.ai.evil.example/cb', false],
    ['https://evil.example/?next=https://claude.ai', false],
    ['https://user@claude.ai/cb', false],
    ['https://claude.ai/cb#fragment', false],
    ['javascript:alert(1)', false],
    ['not a url', false],
    ['http://localhost.evil.example/cb', false],
  ])('%s → %s', (uri, allowed) => {
    expect(isAllowedRedirectUri(config, uri)).toBe(allowed);
  });
});

describe('checkIdTokenClaims', () => {
  const now = 1_800_000_000;
  const good = {
    iss: 'https://accounts.google.com',
    aud: 'client',
    sub: '123',
    email: 'daniel@example.com',
    email_verified: true,
    nonce: 'n',
    iat: now,
    exp: now + 300,
  };
  const check = (overrides) => checkIdTokenClaims({ ...good, ...overrides }, { clientId: 'client', nonce: 'n', now });

  it('accepts a good token', () => expect(check({})).toBeNull());
  it.each([
    [{ iss: 'https://evil.example' }, 'unexpected issuer'],
    [{ aud: 'other' }, 'wrong audience'],
    [{ aud: ['client', 'other'], azp: 'other' }, 'wrong authorized party'],
    [{ exp: now - 120 }, 'expired'],
    [{ iat: now + 600 }, 'issued in the future'],
    [{ nonce: 'x' }, 'nonce mismatch'],
    [{ sub: '' }, 'missing subject'],
    [{ email_verified: 'true' }, 'email not verified'],
    [{ email: undefined }, 'missing email'],
  ])('%j → %s', (overrides, problem) => {
    expect(check(overrides)).toBe(problem);
  });
});
