// Checks the live deployment from outside, as a stranger would see it: only the Cloudflare edge
// protections (WAF, Access, rate limits, workers.dev) can't be tested before deploy, so they're tested
// here. Exits 1 on any failure, and CI then rolls back (or locks down).
//
// A first deploy's custom domain takes a little while to come up, so the checks wait for the origin to
// answer at all (connection failures only; any HTTP answer, right or wrong, ends the wait).
//
//   node scripts/post-deploy-check.mjs [origin]
import { pathToFileURL } from 'node:url';

const DEFAULT_ORIGIN = 'https://mtg-assistant.conrad.tools';
const REACHABLE_TIMEOUT_MS = 180_000;
const REACHABLE_INTERVAL_MS = 5_000;
const METADATA_PATH = '/.well-known/oauth-authorization-server';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Resolves with the first HTTP response from the origin, or null if none came before the timeout.
export async function waitUntilReachable(
  origin,
  {
    fetchImpl = fetch,
    sleep = pause,
    timeoutMs = REACHABLE_TIMEOUT_MS,
    intervalMs = REACHABLE_INTERVAL_MS,
    log = console.log,
  } = {},
) {
  for (let waited = 0; ; waited += intervalMs) {
    try {
      return await fetchImpl(new URL(METADATA_PATH, origin), { redirect: 'manual' });
    } catch (error) {
      if (waited + intervalMs > timeoutMs) return null;
      log(`...  ${origin} not reachable yet (${error.cause?.code ?? error.message}); retrying`);
      await sleep(intervalMs);
    }
  }
}

// The Worker's kill switch answers 503 "Temporarily unavailable" on every route.
const isLockedDown = async (response) =>
  response.status === 503 && (await response.clone().text()).trim() === 'Temporarily unavailable';

// Each check returns null when it passes, or a description of what it found instead.
export function buildChecks(origin, fetchImpl = fetch) {
  const get = (path, init = {}) => fetchImpl(new URL(path, origin), { redirect: 'manual', ...init });
  return [
    [
      'unknown paths are blocked',
      async () => {
        for (const path of ['/', '/admin', '/.env', '/wp-login.php']) {
          const { status } = await get(path);
          if (status !== 403 && status !== 404) return `${path} answered ${status}`;
        }
        return null;
      },
    ],
    [
      'responses carry the security headers',
      async () => {
        const response = await get('/.well-known/oauth-authorization-server');
        const hsts = response.headers.get('strict-transport-security') ?? '';
        if (!hsts.includes('max-age=63072000')) return `HSTS is "${hsts}"`;
        if (response.headers.get('x-content-type-options') !== 'nosniff') return 'missing nosniff';
        return null;
      },
    ],
    [
      'OAuth metadata names this origin',
      async () => {
        const response = await get('/.well-known/oauth-authorization-server');
        if (response.status !== 200) return `status ${response.status}`;
        const { issuer } = await response.json();
        return issuer === origin ? null : `issuer is ${issuer}`;
      },
    ],
    [
      '/mcp refuses requests without a token',
      async () => {
        const response = await get('/mcp', {
          method: 'POST',
          body: '{}',
          headers: { 'Content-Type': 'application/json' },
        });
        if (response.status !== 401) return `status ${response.status}`;
        return (response.headers.get('www-authenticate') ?? '').includes('resource_metadata') ? null : 'no challenge';
      },
    ],
    [
      'Cloudflare Access guards the browser routes',
      async () => {
        for (const path of ['/authorize', '/callback']) {
          const response = await get(path);
          const location = response.headers.get('location') ?? '';
          const viaAccess =
            response.status === 302 && new URL(location, origin).hostname.endsWith('.cloudflareaccess.com');
          if (!viaAccess && response.status !== 403) return `${path} answered ${response.status} ${location}`;
        }
        return null;
      },
    ],
    [
      'the WAF lets Cloudflare Access finish a sign-in',
      async () => {
        // Access completes a sign-in at /cdn-cgi/access/authorized on our host; the WAF must not block it.
        const response = await get('/cdn-cgi/access/authorized');
        const body = await response.text();
        return /you have been blocked/i.test(body) ? 'the WAF blocks /cdn-cgi/access/authorized' : null;
      },
    ],
    [
      '/register is rate limited',
      async () => {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          // A refused redirect URI: nothing is stored, and the attempt is logged.
          const response = await get('/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_name: 'post-deploy probe', redirect_uris: ['https://probe.invalid/cb'] }),
          });
          if (response.status === 429) return null;
          if (response.status !== 400) return `attempt ${attempt + 1} answered ${response.status}`;
        }
        return 'ten registrations in a row were not limited';
      },
    ],
  ];
}

// workers.dev must stay off: checked through the API, since the URL depends on the account's subdomain.
export async function workersDevCheck(env = process.env, fetchImpl = fetch) {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    return 'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are needed';
  }
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/mtg-assistant/subdomain`,
    { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } },
  );
  if (!response.ok) return `subdomain lookup failed (${response.status})`;
  const { result } = await response.json();
  if (result?.enabled) return 'the workers.dev URL is enabled';
  if (result?.previews_enabled) return 'preview URLs are enabled';
  return null;
}

export async function runChecks(origin, { fetchImpl = fetch, env = process.env, log = console.log, sleep } = {}) {
  const first = await waitUntilReachable(origin, { fetchImpl, sleep, log });
  if (!first) {
    log(`FAIL ${origin} is reachable: no answer within ${REACHABLE_TIMEOUT_MS / 1000}s`);
    return 1;
  }
  if (await isLockedDown(first)) {
    log('FAIL the Worker is in LOCKDOWN: check why, then `mise run auth:unlock` and re-run this check');
    return 1;
  }
  const checks = [
    ...buildChecks(origin, fetchImpl),
    ['workers.dev and preview URLs are off', () => workersDevCheck(env, fetchImpl)],
  ];
  let failed = 0;
  for (const [name, check] of checks) {
    let problem;
    try {
      problem = await check();
    } catch (error) {
      problem = `threw ${error.message}`;
    }
    if (problem) failed += 1;
    log(`${problem ? 'FAIL' : 'ok  '} ${name}${problem ? `: ${problem}` : ''}`);
  }
  return failed;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failed = await runChecks(process.argv[2] ?? DEFAULT_ORIGIN);
  process.exitCode = failed ? 1 : 0;
}
