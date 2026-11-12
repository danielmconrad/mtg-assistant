// Two test projects: "worker" runs inside workerd with local D1, KV and rate limiters (the Worker and
// everything it imports); "node" runs repo-level checks such as the wrangler.jsonc invariants.
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Test-only identity and configuration. The values are fakes, never real credentials.
export const TEST_BINDINGS = {
  PUBLIC_ORIGIN: 'https://mtg-assistant.test',
  ALLOWED_EMAILS: 'daniel@example.com,second@example.com',
  ALLOWED_REDIRECT_HOSTS: 'claude.ai,claude.com',
  GOOGLE_CLIENT_ID: 'test-google-client',
  GOOGLE_CLIENT_SECRET: 'test-google-secret',
  ACCESS_TEAM_DOMAIN: 'team.example.com',
  ACCESS_AUD: 'test-access-aud',
  OAUTH_CLIENT_ALERT_THRESHOLD: '5',
};

export default defineConfig(async () => {
  const migrations = await readD1Migrations('migrations');
  return {
    test: {
      projects: [
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: './wrangler.jsonc' },
              miniflare: { bindings: { ...TEST_BINDINGS, TEST_MIGRATIONS: migrations } },
            }),
          ],
          test: { name: 'worker', include: ['tests/worker/**/*.test.mjs'], setupFiles: ['tests/worker/setup.mjs'] },
        },
        { test: { name: 'node', environment: 'node', include: ['tests/node/**/*.test.mjs'] } },
      ],
      coverage: {
        provider: 'istanbul',
        include: ['src/**'],
        thresholds: { lines: 80 },
      },
    },
  };
});
