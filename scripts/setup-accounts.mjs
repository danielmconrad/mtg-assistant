// Creates or updates everything this project needs in Cloudflare and GitHub, from the values in .env
// (see .env.example). Safe to re-run: each step checks the current state first.
//
//   mise run setup:accounts              # show the plan; changes nothing
//   mise run setup:accounts -- --apply   # make the changes
//
// Cloudflare: the D1 database and KV namespace (IDs written into wrangler.jsonc), the Access login in
// front of the browser routes, the zone's HTTPS settings, a WAF rule that blocks every path the Worker
// doesn't serve, a coarse edge rate limit, and the Worker's secrets.
// GitHub: Actions variables and secrets for deploys, the production environment, the main-branch
// ruleset, and Dependabot and secret-scanning settings.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { applyEdits, modify, parse } from 'jsonc-parser';

const WORKER = 'mtg-assistant';
const D1_NAME = 'mtg-assistant';
const KV_TITLE = 'mtg-assistant-oauth';
const ACCESS_APP = 'mtg-assistant browser routes';
const ACCESS_POLICY = 'mtg-assistant allowlist';
const RULE_PREFIX = 'mtg-assistant-';
// The Worker's public paths (src/index.mjs ROUTES). The WAF blocks everything else at the edge.
export const PUBLIC_PATHS = [
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/register',
  '/token',
  '/authorize',
  '/callback',
  '/download',
  '/mcp',
];
// Cloudflare Access serves its own endpoints on our hostname (the redirect that completes a sign-in is
// /cdn-cgi/access/authorized). They're answered at the edge and never reach the Worker, but the WAF runs
// first, so they must be let through. Nothing else under /cdn-cgi/ is.
export const ACCESS_EDGE_PREFIX = '/cdn-cgi/access/';
// Paths only a person in a browser opens; Cloudflare Access guards them.
export const ACCESS_PATHS = ['/authorize', '/callback', '/download'];
const CHECK_CONTEXTS = ['lint', 'test', 'scan'];
// Worker secrets setup:accounts makes itself (32 random bytes each) rather than reading from .env.
export const GENERATED_SECRETS = ['DOWNLOAD_SIGNING_KEY'];
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
// Pure helpers (tested in tests/node/setup-accounts.test.mjs)
// ---------------------------------------------------------------------------------------------

const quote = (value) => `"${String(value).replace(/["\\]/g, '\\$&')}"`;

export function blockUnknownPathsRule(host) {
  return {
    ref: `${RULE_PREFIX}block-unknown-paths`,
    description: 'mtg-assistant: block every path the Worker does not serve',
    expression:
      `(http.host eq ${quote(host)}` +
      ` and not (http.request.uri.path in {${PUBLIC_PATHS.map(quote).join(' ')}})` +
      ` and not starts_with(http.request.uri.path, ${quote(ACCESS_EDGE_PREFIX)}))`,
    action: 'block',
    enabled: true,
  };
}

// The Free plan allows one rate limiting rule with a 10-second period; the Worker enforces the
// finer per-route limits itself.
export function edgeRateLimitRule(host) {
  return {
    ref: `${RULE_PREFIX}edge-rate-limit`,
    description: 'mtg-assistant: coarse per-IP limit in front of the Worker',
    expression: `(http.host eq ${quote(host)})`,
    action: 'block',
    ratelimit: {
      characteristics: ['ip.src', 'cf.colo.id'],
      period: 10,
      requests_per_period: 50,
      mitigation_timeout: 10,
    },
    enabled: true,
  };
}

// A phase entrypoint holds every rule in the zone, so ours are swapped in by ref and others kept.
export function mergeRules(existing, ours) {
  const strip = ({ version: _version, last_updated: _updated, ...rule }) => rule;
  const others = existing.filter((rule) => !String(rule.ref ?? '').startsWith(RULE_PREFIX)).map(strip);
  return [...others, ...ours];
}

const comparable = (rules) =>
  JSON.stringify(
    rules.map(({ ref, expression, action, ratelimit, enabled }) => ({ ref, expression, action, ratelimit, enabled })),
  );

export function rulesNeedUpdate(existing, ours) {
  const current = existing.filter((rule) => String(rule.ref ?? '').startsWith(RULE_PREFIX));
  return comparable(current) !== comparable(ours);
}

// Sets values in wrangler.jsonc, keeping its comments and layout.
export function editWranglerConfig(text, values) {
  const config = parse(text);
  let edited = text;
  const set = (path, value) => {
    edited = applyEdits(edited, modify(edited, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  };
  const kvIndex = config.kv_namespaces.findIndex((namespace) => namespace.binding === 'OAUTH_KV');
  const d1Index = config.d1_databases.findIndex((database) => database.binding === 'DB');
  if (values.kvId) set(['kv_namespaces', kvIndex, 'id'], values.kvId);
  if (values.d1Id) set(['d1_databases', d1Index, 'database_id'], values.d1Id);
  if (values.teamDomain) set(['vars', 'ACCESS_TEAM_DOMAIN'], values.teamDomain);
  if (values.accessAud) set(['vars', 'ACCESS_AUD'], values.accessAud);
  return edited;
}

export function validateEnv(env) {
  const problems = [];
  const required = [
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_API_TOKEN',
    'MTG_ASSISTANT_HOST',
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
// API clients
// ---------------------------------------------------------------------------------------------

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function cf(method, path, body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.success === false) {
    const messages = (json.errors ?? []).map((error) => `${error.code}: ${error.message}`).join('; ');
    throw new ApiError(`Cloudflare ${method} ${path} failed (${response.status}) ${messages}`, response.status);
  }
  return json.result;
}

// Runs gh with GH_TOKEN from .env. Secret values go through stdin, never argv.
function gh(args, input) {
  try {
    return execFileSync('gh', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    throw new ApiError(`gh ${args.slice(0, 3).join(' ')} failed: ${String(error.stderr).trim()}`, error.status);
  }
}

const ghApi = (method, path, body) => {
  const output = gh(
    ['api', '-X', method, path, ...(body ? ['--input', '-'] : [])],
    body ? JSON.stringify(body) : undefined,
  );
  return output.trim() ? JSON.parse(output) : null;
};

function repoSlug() {
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  const match = url.match(/github\.com[:/]([^/]+\/[^/.]+)(\.git)?$/);
  if (!match) throw new Error(`origin ${url} is not a GitHub repository`);
  return match[1];
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

async function findZone(env) {
  const host = env.MTG_ASSISTANT_HOST;
  const zoneName = host.split('.').slice(-2).join('.');
  const zones = await cf('GET', `/zones?name=${encodeURIComponent(zoneName)}`);
  if (!zones.length) throw new Error(`Zone ${zoneName} isn't in this Cloudflare account`);
  const zone = zones[0];
  if (env.CLOUDFLARE_ZONE_ID && env.CLOUDFLARE_ZONE_ID !== zone.id) {
    warn(`CLOUDFLARE_ZONE_ID doesn't match ${zoneName} (${zone.id})`);
  }
  ok(`zone ${zoneName} (${zone.plan?.name ?? 'unknown plan'})`);
  return zone;
}

async function ensureD1(account) {
  const databases = await cf('GET', `/accounts/${account}/d1/database?name=${D1_NAME}`);
  const existing = databases.find((database) => database.name === D1_NAME);
  if (existing) {
    ok(`D1 database ${D1_NAME} exists`);
    return existing.uuid;
  }
  const created = await change(`create D1 database ${D1_NAME}`, () =>
    cf('POST', `/accounts/${account}/d1/database`, { name: D1_NAME }),
  );
  return created?.uuid;
}

async function ensureKv(account) {
  const namespaces = await cf('GET', `/accounts/${account}/storage/kv/namespaces?per_page=100`);
  const existing = namespaces.find((namespace) => namespace.title === KV_TITLE);
  if (existing) {
    ok(`KV namespace ${KV_TITLE} exists`);
    return existing.id;
  }
  const created = await change(`create KV namespace ${KV_TITLE}`, () =>
    cf('POST', `/accounts/${account}/storage/kv/namespaces`, { title: KV_TITLE }),
  );
  return created?.id;
}

async function ensureIdentityProvider(account, env) {
  const providers = await cf('GET', `/accounts/${account}/access/identity_providers`);
  if (env.ACCESS_GOOGLE_CLIENT_ID) {
    const config = { client_id: env.ACCESS_GOOGLE_CLIENT_ID, client_secret: env.ACCESS_GOOGLE_CLIENT_SECRET };
    const existing = providers.find((provider) => provider.type === 'google');
    if (existing) {
      // The secret can't be read back, so it's re-sent on every apply.
      await change('update the Access Google login', () =>
        cf('PUT', `/accounts/${account}/access/identity_providers/${existing.id}`, {
          name: 'Google',
          type: 'google',
          config,
        }),
      );
      return existing.id;
    }
    const created = await change('add Google as the Access login', () =>
      cf('POST', `/accounts/${account}/access/identity_providers`, { name: 'Google', type: 'google', config }),
    );
    return created?.id;
  }
  const existing = providers.find((provider) => provider.type === 'onetimepin');
  if (existing) {
    ok('Access one-time PIN login exists');
    return existing.id;
  }
  const created = await change('add one-time PIN as the Access login', () =>
    cf('POST', `/accounts/${account}/access/identity_providers`, {
      name: 'One-time PIN',
      type: 'onetimepin',
      config: {},
    }),
  );
  return created?.id;
}

async function ensureAccessPolicy(account, emails) {
  const policy = {
    name: ACCESS_POLICY,
    decision: 'allow',
    include: emails.map((email) => ({ email: { email } })),
    session_duration: '24h',
  };
  const policies = await cf('GET', `/accounts/${account}/access/policies`);
  const existing = policies.find((candidate) => candidate.name === ACCESS_POLICY);
  if (!existing) {
    const created = await change(`create the Access policy allowing ${emails.join(', ')}`, () =>
      cf('POST', `/accounts/${account}/access/policies`, policy),
    );
    return created?.id;
  }
  const current = (existing.include ?? []).map((rule) => rule.email?.email).sort();
  if (JSON.stringify(current) === JSON.stringify([...emails].sort())) {
    ok(`Access policy allows ${emails.join(', ')}`);
  } else {
    await change(`set the Access policy to allow ${emails.join(', ')}`, () =>
      cf('PUT', `/accounts/${account}/access/policies/${existing.id}`, policy),
    );
  }
  return existing.id;
}

async function ensureAccessApp(account, host, idpId, policyId) {
  const app = {
    name: ACCESS_APP,
    type: 'self_hosted',
    domain: `${host}${ACCESS_PATHS[0]}`,
    destinations: ACCESS_PATHS.map((path) => ({ type: 'public', uri: `${host}${path}` })),
    allowed_idps: idpId ? [idpId] : [],
    auto_redirect_to_identity: true,
    app_launcher_visible: false,
    session_duration: '24h',
    http_only_cookie_attribute: true,
    same_site_cookie_attribute: 'lax',
    enable_binding_cookie: true,
    policies: policyId ? [{ id: policyId, precedence: 1 }] : [],
  };
  const apps = await cf('GET', `/accounts/${account}/access/apps`);
  const existing = apps.find((candidate) => candidate.name === ACCESS_APP);
  if (existing) {
    await change(`update the Access application for ${ACCESS_PATHS.join(', ')}`, () =>
      cf('PUT', `/accounts/${account}/access/apps/${existing.id}`, app),
    );
    return existing.aud;
  }
  const created = await change(`create the Access application for ${ACCESS_PATHS.join(', ')}`, () =>
    cf('POST', `/accounts/${account}/access/apps`, app),
  );
  return created?.aud;
}

async function ensureZoneSettings(zone) {
  for (const [setting, value] of [
    ['always_use_https', 'on'],
    ['min_tls_version', '1.2'],
  ]) {
    const current = await cf('GET', `/zones/${zone.id}/settings/${setting}`);
    if (current.value === value) ok(`${setting} is ${value}`);
    else {
      await change(`set ${setting} to ${value}`, () => cf('PATCH', `/zones/${zone.id}/settings/${setting}`, { value }));
    }
  }
}

async function ensurePhaseRules(zone, phase, ours) {
  let existing = [];
  try {
    existing = (await cf('GET', `/zones/${zone.id}/rulesets/phases/${phase}/entrypoint`)).rules ?? [];
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  if (!rulesNeedUpdate(existing, ours)) return ok(`${phase} rules are current`);
  return change(`write ${ours.map((rule) => rule.ref).join(', ')} to ${phase} (other rules kept)`, () =>
    cf('PUT', `/zones/${zone.id}/rulesets/phases/${phase}/entrypoint`, { rules: mergeRules(existing, ours) }),
  );
}

async function ensureWorkerSecrets(account, env) {
  try {
    await cf('GET', `/accounts/${account}/workers/scripts/${WORKER}/settings`);
  } catch (error) {
    if (error.status !== 404) throw error;
    warn('The Worker is not deployed yet: push to main to deploy it, then re-run setup:accounts to set its secrets');
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

function ensureVariable(repo, name, value) {
  const current = JSON.parse(gh(['variable', 'list', '--repo', repo, '--json', 'name,value'])).find(
    (variable) => variable.name === name,
  );
  if (current?.value === value) return ok(`Actions variable ${name} is set`);
  return change(`set Actions variable ${name}`, () => gh(['variable', 'set', name, '--repo', repo, '--body', value]));
}

// Returns true when the production environment, limited to main, is available.
async function ensureEnvironment(repo) {
  try {
    const environment = ghApi('GET', `/repos/${repo}/environments/production`);
    if (environment?.deployment_branch_policy?.custom_branch_policies) {
      ok('production environment is limited to main');
      return true;
    }
  } catch (error) {
    if (!String(error.message).includes('404') && !String(error.message).includes('Not Found')) throw error;
  }
  try {
    await change('create the production environment, deployable only from main', () => {
      ghApi('PUT', `/repos/${repo}/environments/production`, {
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      });
      ghApi('POST', `/repos/${repo}/environments/production/deployment-branch-policies`, {
        name: 'main',
        type: 'branch',
      });
    });
    return true;
  } catch (error) {
    warn(
      `Couldn't create the production environment (${error.message}). Private repos need GitHub Pro for this; deploy secrets fall back to repository secrets`,
    );
    return false;
  }
}

function ensureSecret(repo, name, value, environment) {
  const scope = environment ? ['--env', environment] : [];
  return change(`set Actions secret ${name}${environment ? ` in ${environment}` : ''}`, () => {
    try {
      return gh(['secret', 'set', name, '--repo', repo, ...scope], value);
    } catch (error) {
      // GitHub's 403 doesn't name the missing permission; the X-Accepted-GitHub-Permissions header does.
      if (/HTTP 403/.test(error.message)) {
        const permission = environment ? 'Environments' : 'Secrets';
        throw new ApiError(
          `${error.message}\nGH_TOKEN needs the "${permission}: Read and write" repository permission (see .env.example section 5).`,
          403,
        );
      }
      throw error;
    }
  });
}

async function ensureRuleset(repo) {
  const rulesets = ghApi('GET', `/repos/${repo}/rulesets`) ?? [];
  const name = 'main: checks before merge';
  const ruleset = {
    name,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: CHECK_CONTEXTS.map((context) => ({ context })),
        },
      },
    ],
  };
  const existing = rulesets.find((candidate) => candidate.name === name);
  try {
    await change(
      `${existing ? 'update' : 'create'} the main ruleset (PRs only, ${CHECK_CONTEXTS.join('/')} must pass, no force-push or deletion)`,
      () =>
        existing
          ? ghApi('PUT', `/repos/${repo}/rulesets/${existing.id}`, ruleset)
          : ghApi('POST', `/repos/${repo}/rulesets`, ruleset),
    );
  } catch (error) {
    warn(`Couldn't set the main ruleset (${error.message}). Private repos need GitHub Pro for rulesets`);
  }
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
  const host = env.MTG_ASSISTANT_HOST;
  const emails = env.ALLOWED_EMAILS.split(',')
    .map((email) => email.trim())
    .filter(Boolean);
  console.log('Cloudflare');
  await verifyCloudflareToken(account);
  const zone = await findZone(env);
  const d1Id = await ensureD1(account);
  const kvId = await ensureKv(account);
  const { auth_domain: teamDomain } = await cf('GET', `/accounts/${account}/access/organizations`);
  if (env.CLOUDFLARE_ACCESS_TEAM_DOMAIN && env.CLOUDFLARE_ACCESS_TEAM_DOMAIN !== teamDomain) {
    warn(`CLOUDFLARE_ACCESS_TEAM_DOMAIN is ${env.CLOUDFLARE_ACCESS_TEAM_DOMAIN}, but the account's is ${teamDomain}`);
  }
  const idpId = await ensureIdentityProvider(account, env);
  const policyId = await ensureAccessPolicy(account, emails);
  const accessAud = await ensureAccessApp(account, host, idpId, policyId);
  await ensureZoneSettings(zone);
  await ensurePhaseRules(zone, 'http_request_firewall_custom', [blockUnknownPathsRule(host)]);
  await ensurePhaseRules(zone, 'http_ratelimit', [edgeRateLimitRule(host)]);

  const wranglerText = await readFile('wrangler.jsonc', 'utf8');
  const edited = editWranglerConfig(wranglerText, { d1Id, kvId, teamDomain, accessAud });
  if (edited === wranglerText) ok('wrangler.jsonc has the resource IDs');
  else {
    await change('write resource IDs and Access settings into wrangler.jsonc (commit it)', () =>
      writeFile('wrangler.jsonc', edited),
    );
  }
  await ensureWorkerSecrets(account, env);
  return { ready: Boolean(d1Id && kvId) };
}

async function setupGithub(env, { ready }) {
  console.log('\nGitHub');
  const repo = repoSlug();
  const info = ghApi('GET', `/repos/${repo}`);
  ok(`${repo} is ${info.private ? 'private' : 'public'}`);
  const environment = (await ensureEnvironment(repo)) ? 'production' : undefined;
  for (const name of ['CLOUDFLARE_DEPLOY_API_TOKEN', 'CLOUDFLARE_INGEST_API_TOKEN']) {
    if (env[name]) await ensureSecret(repo, name, env[name], environment);
    else warn(`${name} is empty, so CI can't use it yet`);
  }
  await ensureVariable(repo, 'CLOUDFLARE_ACCOUNT_ID', env.CLOUDFLARE_ACCOUNT_ID);
  await ensureRuleset(repo);
  await ensureRepoSecurity(repo);
  // Last: deploys start only once everything above exists.
  if (env.CLOUDFLARE_DEPLOY_API_TOKEN && ready) await ensureVariable(repo, 'DEPLOY_ENABLED', 'true');
}

async function main() {
  const problems = validateEnv(process.env);
  if (problems.length) {
    console.error(`Fill in .env first (see .env.example):\n  ${problems.join('\n  ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(apply ? 'Applying changes.\n' : 'Plan only. Re-run with --apply to make these changes.\n');
  const resources = await setupCloudflare(process.env);
  await setupGithub(process.env, resources);
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  console.log(`\n${apply ? 'Done' : 'Plan'}: ${plural(changes, 'change')}, ${plural(warnings.length, 'warning')}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  });
}
