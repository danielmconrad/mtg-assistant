// Sets the values OpenTofu (infra/) deliberately doesn't manage, so no secret is ever written to its
// state: the Worker's secrets, the GitHub Actions secrets for deploys and the nightly ingest, and the
// Access Google login (it holds a client secret). Also turns on Dependabot and secret scanning, which
// OpenTofu could only manage by taking over the whole repository's settings. Values come from .env.
//
//   mise run setup:secrets              # show the plan; changes nothing
//   mise run setup:secrets -- --apply   # make the changes
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ApiError, cf, gh, ghApi, ghFind } from './accounts/api.mjs';
import { originRepo } from './tofu.mjs';

const WORKER = 'mtg-assistant';
// Worker secrets setup:secrets makes itself (32 random bytes each) rather than reading from .env.
export const GENERATED_SECRETS = ['DOWNLOAD_SIGNING_KEY', 'UPLOAD_SIGNING_KEY'];
export const randomKey = () => randomBytes(32).toString('base64');

const apply = process.argv.includes('--apply');
const warnings = [];
let changes = 0;

function log(symbol, message) {
  console.log(`${symbol} ${message}`);
}

// Runs fn only with --apply; otherwise records what it would do.
async function change(description, fn) {
  changes += 1;
  if (!apply) return log('+', `would ${description}`);
  const result = await fn();
  log('✓', description);
  return result;
}

const ok = (message) => log('·', message);
const warn = (message) => {
  warnings.push(message);
  log('!', message);
};

// ---------------------------------------------------------------------------------------------
// Pure helpers (tested in tests/node/setup-secrets.test.mjs)
// ---------------------------------------------------------------------------------------------

export function validateEnv(env) {
  const problems = [];
  const required = [
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_API_TOKEN',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'ALLOWED_EMAILS',
    'GH_TOKEN',
  ];
  for (const name of required) if (!env[name]?.trim()) problems.push(`${name} is empty`);
  const emails = (env.ALLOWED_EMAILS ?? '').split(',').map((email) => email.trim());
  if (emails.some((email) => email && (email !== email.toLowerCase() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)))) {
    problems.push('ALLOWED_EMAILS must be lowercase emails separated by commas');
  }
  if (Boolean(env.ACCESS_GOOGLE_CLIENT_ID) !== Boolean(env.ACCESS_GOOGLE_CLIENT_SECRET)) {
    problems.push('Set both ACCESS_GOOGLE_CLIENT_ID and ACCESS_GOOGLE_CLIENT_SECRET, or neither (one-time PIN)');
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Cloudflare
// ---------------------------------------------------------------------------------------------

async function verifyCloudflareToken(account) {
  // Account-owned tokens verify under the account; user tokens under /user.
  const status = await cf('GET', `/accounts/${account}/tokens/verify`).catch(() => cf('GET', '/user/tokens/verify'));
  if (status.status !== 'active') throw new Error(`CLOUDFLARE_API_TOKEN is ${status.status}`);
  if (status.expires_on) ok(`Cloudflare token is active, expires ${status.expires_on}`);
  else warn('CLOUDFLARE_API_TOKEN has no expiry; give it one (about 90 days)');
}

// The Access Google login. infra/ looks it up by type and puts it in front of the browser routes, so
// run this before the first infra:apply. Without ACCESS_GOOGLE_CLIENT_ID, infra/ uses one-time PIN.
async function ensureGoogleLogin(account, env) {
  if (!env.ACCESS_GOOGLE_CLIENT_ID) return ok('no Access Google login configured (infra/ uses one-time PIN)');
  const config = { client_id: env.ACCESS_GOOGLE_CLIENT_ID, client_secret: env.ACCESS_GOOGLE_CLIENT_SECRET };
  const providers = await cf('GET', `/accounts/${account}/access/identity_providers`);
  const existing = providers.find((provider) => provider.type === 'google');
  if (existing) {
    // The secret can't be read back, so it's re-sent on every apply.
    return change('update the Access Google login', () =>
      cf('PUT', `/accounts/${account}/access/identity_providers/${existing.id}`, {
        name: 'Google',
        type: 'google',
        config,
      }),
    );
  }
  return change('add Google as the Access login', () =>
    cf('POST', `/accounts/${account}/access/identity_providers`, { name: 'Google', type: 'google', config }),
  );
}

async function ensureWorkerSecrets(account, env) {
  try {
    await cf('GET', `/accounts/${account}/workers/scripts/${WORKER}/settings`);
  } catch (error) {
    if (error.status !== 404) throw error;
    warn('The Worker is not deployed yet: push to main to deploy it, then re-run setup:secrets to set its secrets');
    return;
  }
  // Secret values can't be read back, so they're re-sent on every apply.
  for (const name of ['ALLOWED_EMAILS', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) {
    await change(`set Worker secret ${name}`, () =>
      cf('PUT', `/accounts/${account}/workers/scripts/${WORKER}/secrets`, {
        name,
        text: env[name],
        type: 'secret_text',
      }),
    );
  }
  // Signing keys are generated here and sent straight to the Worker, never written to disk or shown. One
  // that's already set is kept, so links already handed out keep working.
  const existing = new Set(
    (await cf('GET', `/accounts/${account}/workers/scripts/${WORKER}/secrets`)).map((secret) => secret.name),
  );
  for (const name of GENERATED_SECRETS) {
    if (existing.has(name)) {
      ok(`Worker secret ${name} is set`);
      continue;
    }
    await change(`generate Worker secret ${name}`, () =>
      cf('PUT', `/accounts/${account}/workers/scripts/${WORKER}/secrets`, {
        name,
        text: randomKey(),
        type: 'secret_text',
      }),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------------------------

function ensureSecret(repo, name, value, environment) {
  return change(`set Actions secret ${name} in ${environment}`, () => {
    try {
      return gh(['secret', 'set', name, '--repo', repo, '--env', environment], value);
    } catch (error) {
      // GitHub's 403 doesn't name the missing permission; the X-Accepted-GitHub-Permissions header does.
      if (/HTTP 403/.test(error.message)) {
        throw new ApiError(
          `${error.message}\nGH_TOKEN needs the "Environments: Read and write" repository permission (see .env.example section 5).`,
          403,
        );
      }
      throw error;
    }
  });
}

async function ensureRepoSecurity(repo) {
  for (const [label, path] of [
    ['Dependabot alerts', `/repos/${repo}/vulnerability-alerts`],
    ['Dependabot security updates', `/repos/${repo}/automated-security-fixes`],
  ]) {
    try {
      await change(`turn on ${label}`, () => ghApi('PUT', path));
    } catch (error) {
      warn(`Couldn't turn on ${label} (${error.message})`);
    }
  }
  try {
    await change('turn on secret scanning and push protection', () =>
      ghApi('PATCH', `/repos/${repo}`, {
        security_and_analysis: {
          secret_scanning: { status: 'enabled' },
          secret_scanning_push_protection: { status: 'enabled' },
        },
      }),
    );
  } catch (error) {
    warn(
      `Couldn't turn on secret scanning (${error.message}). Private repos need GitHub Advanced Security for it; gitleaks still runs in CI and pre-commit`,
    );
  }
}

// ---------------------------------------------------------------------------------------------

async function setupCloudflare(env) {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  console.log('Cloudflare');
  await verifyCloudflareToken(account);
  await ensureGoogleLogin(account, env);
  await ensureWorkerSecrets(account, env);
}

async function setupGithub(env) {
  console.log('\nGitHub');
  const { owner, name } = originRepo();
  const repo = `${owner}/${name}`;
  // infra/ makes the production environment; the deploy secrets live in it.
  if (!ghFind(`/repos/${repo}/environments/production`)) {
    warn('The production environment does not exist yet: run mise run infra:apply, then re-run setup:secrets');
  } else {
    for (const secret of ['CLOUDFLARE_DEPLOY_API_TOKEN', 'CLOUDFLARE_INGEST_API_TOKEN']) {
      if (env[secret]) await ensureSecret(repo, secret, env[secret], 'production');
      else warn(`${secret} is empty, so CI can't use it yet`);
    }
  }
  await ensureRepoSecurity(repo);
}

async function main() {
  const problems = validateEnv(process.env);
  if (problems.length) {
    console.error(`Fill in .env first (see .env.example):\n  ${problems.join('\n  ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(apply ? 'Applying changes.\n' : 'Plan only. Re-run with --apply to make these changes.\n');
  await setupCloudflare(process.env);
  await setupGithub(process.env);
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  console.log(`\n${apply ? 'Done' : 'Plan'}: ${plural(changes, 'change')}, ${plural(warnings.length, 'warning')}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  });
}
