// Short-lived signed links a person opens in their browser: collection downloads now, upload pages later.
// A token is base64url(JSON claims).base64url(HMAC-SHA256 of that), and its claims name its purpose,
// user, expiry and a random nonce. Each nonce works a few times (browsers prefetch), counted in D1.

const encoder = new TextEncoder();
// A signing key shorter than this is treated as missing.
export const MIN_KEY_LENGTH = 32;
const TOKEN = /^([A-Za-z0-9_-]{1,4096})\.([A-Za-z0-9_-]{43})$/;

// The signing key isn't set, so links can be neither made nor checked.
export class LinkKeyMissing extends Error {}

const toBase64Url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const fromBase64Url = (text) =>
  Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));

function hmacKey(secret) {
  if (typeof secret !== 'string' || secret.length < MIN_KEY_LENGTH) throw new LinkKeyMissing();
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

// Returns { token, claims }. claims must hold user (the signed-in user's ID) and anything the link needs.
export async function signLink(secret, purpose, claims, { now, ttlMs }) {
  const signed = { ...claims, purpose, exp: now + ttlMs, nonce: crypto.randomUUID() };
  const body = toBase64Url(encoder.encode(JSON.stringify(signed)));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body));
  return { token: `${body}.${toBase64Url(new Uint8Array(signature))}`, claims: signed };
}

// Returns { claims } for a valid, unexpired token made for purpose, or { problem }.
export async function verifyLink(secret, purpose, token, now) {
  const key = await hmacKey(secret);
  const match = TOKEN.exec(token ?? '');
  if (!match) return { problem: 'malformed token' };
  // crypto.subtle.verify compares in constant time.
  const valid = await crypto.subtle.verify('HMAC', key, fromBase64Url(match[2]), encoder.encode(match[1]));
  if (!valid) return { problem: 'bad signature' };
  const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(match[1])));
  if (claims.purpose !== purpose) return { problem: 'link made for something else' };
  if (!(claims.exp > now)) return { problem: 'expired' };
  return { claims };
}

// Counts one use of a link. Returns false once it has been used maxUses times. The upsert is a single
// statement, so two requests at once can't both take the last use.
export async function useLink(db, claims, maxUses, now) {
  await db.prepare('DELETE FROM link_uses WHERE expires_at < ?').bind(now).run();
  const row = await db
    .prepare(
      `INSERT INTO link_uses (nonce, user_id, expires_at, uses) VALUES (?, ?, ?, 1)
       ON CONFLICT (nonce) DO UPDATE SET uses = uses + 1 WHERE uses < ?
       RETURNING uses`,
    )
    .bind(claims.nonce, claims.user, claims.exp, maxUses)
    .first();
  return row !== null;
}
