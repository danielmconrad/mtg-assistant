// Users and the auth audit log, in D1. A user's Google subject is pinned at first sign-in, so a
// recycled or reassigned email address can't take over the account.

// Returns { user } or { problem }.
export async function signInUser(db, { email, sub }) {
  const byEmail = await db
    .prepare('SELECT id, email, google_sub, disabled FROM users WHERE email = ?')
    .bind(email)
    .first();
  if (byEmail) {
    if (byEmail.disabled) return { problem: 'account disabled' };
    if (byEmail.google_sub !== sub) {
      return { problem: 'Google account does not match the one first used for this email' };
    }
    await db
      .prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), byEmail.id)
      .run();
    return { user: byEmail };
  }
  const bySub = await db.prepare('SELECT id FROM users WHERE google_sub = ?').bind(sub).first();
  if (bySub) return { problem: 'this Google account is registered under another email' };
  const now = new Date().toISOString();
  const user = { id: crypto.randomUUID(), email, google_sub: sub };
  await db
    .prepare('INSERT INTO users (id, email, google_sub, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)')
    .bind(user.id, email, sub, now, now)
    .run();
  return { user };
}

// The user behind a token, if still active and still matching the token's identity.
export async function activeUser(db, { userId, email, sub }) {
  const user = await db.prepare('SELECT id, email, google_sub, disabled FROM users WHERE id = ?').bind(userId).first();
  if (!user || user.disabled || user.email !== email || user.google_sub !== sub) return null;
  return user;
}

// Records a security-relevant event. Never pass secrets, tokens or purchase prices in detail.
export async function logAuthEvent(db, request, type, { email = null, detail = null } = {}) {
  try {
    await db
      .prepare('INSERT INTO auth_events (at, type, email, ip, detail) VALUES (?, ?, ?, ?, ?)')
      .bind(
        new Date().toISOString(),
        type,
        email,
        request?.headers.get('CF-Connecting-IP') ?? null,
        detail === null ? null : JSON.stringify(detail).slice(0, 2000),
      )
      .run();
  } catch (error) {
    // Logging must never decide whether a request succeeds, but a failure should still be visible.
    console.error('auth_events insert failed', error?.message);
  }
}
