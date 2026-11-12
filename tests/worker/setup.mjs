import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeEach, vi } from 'vitest';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Storage persists between tests in a file, so each test starts from empty KV and tables.
beforeEach(async () => {
  let cursor;
  do {
    const page = await env.OAUTH_KV.list({ cursor });
    await Promise.all(page.keys.map((key) => env.OAUTH_KV.delete(key.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  await env.DB.batch([env.DB.prepare('DELETE FROM auth_events'), env.DB.prepare('DELETE FROM users')]);
});

afterEach(() => vi.restoreAllMocks());
