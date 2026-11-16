// Runs OpenTofu in infra/ with the values from .env (which mise loads into every task), passed the way
// OpenTofu and its providers read them. Run it through mise: mise run infra:plan, infra:apply, ...
//
//   node scripts/tofu.mjs plan
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const REQUIRED = [
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_ZONE_ID',
  'CLOUDFLARE_API_TOKEN',
  'MTG_ASSISTANT_HOST',
  'ALLOWED_EMAILS',
  'GH_TOKEN',
  'TOFU_STATE_ACCESS_KEY_ID',
  'TOFU_STATE_SECRET_ACCESS_KEY',
  'TOFU_STATE_PASSPHRASE',
];

// owner and name of a GitHub remote URL (https or ssh).
export function githubRepo(url) {
  const match = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) throw new Error(`origin ${url} is not a GitHub repository`);
  return { owner: match[1], name: match[2] };
}

// The environment OpenTofu runs with: .env's values as TF_VAR_* inputs, the state bucket's R2 key pair
// as the S3 backend reads it, and GH_TOKEN as the GitHub provider reads it.
export function tofuEnv(env, repo) {
  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`Fill these in .env first (see .env.example): ${missing.join(', ')}`);
  return {
    ...env,
    TF_VAR_cloudflare_account_id: env.CLOUDFLARE_ACCOUNT_ID,
    TF_VAR_cloudflare_zone_id: env.CLOUDFLARE_ZONE_ID,
    TF_VAR_host: env.MTG_ASSISTANT_HOST,
    TF_VAR_allowed_emails: env.ALLOWED_EMAILS,
    // The Google login holds a secret, so setup:secrets manages it; without one, OpenTofu manages one-time PIN.
    TF_VAR_access_login: env.ACCESS_GOOGLE_CLIENT_ID?.trim() ? 'google' : 'onetimepin',
    TF_VAR_github_owner: repo.owner,
    TF_VAR_github_repository: repo.name,
    TF_VAR_state_passphrase: env.TOFU_STATE_PASSPHRASE,
    AWS_ACCESS_KEY_ID: env.TOFU_STATE_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: env.TOFU_STATE_SECRET_ACCESS_KEY,
    GITHUB_TOKEN: env.GH_TOKEN,
  };
}

export function originRepo() {
  return githubRepo(execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim());
}

// Runs tofu in infra/ and returns its exit status; captures stdout when asked.
export function runTofu(args, { capture = false } = {}) {
  const result = spawnSync('tofu', ['-chdir=infra', ...args], {
    env: tofuEnv(process.env, originRepo()),
    stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'],
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = runTofu(process.argv.slice(2)).status;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
