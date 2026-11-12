// Reads the Worker's configuration from env once per request. Every value that decides who gets in is
// parsed here, so the rules live in one place.

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const splitList = (value) =>
  String(value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

export const isLoopbackHost = (host) => LOOPBACK_HOSTS.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host);

export function readConfig(env) {
  const origin = new URL(env.PUBLIC_ORIGIN);
  const isLocal = origin.protocol === 'http:' && isLoopbackHost(origin.hostname);
  if (origin.protocol !== 'https:' && !isLocal) throw new Error('PUBLIC_ORIGIN must be https outside local dev');
  return {
    origin: origin.origin,
    isLocal,
    allowedEmails: new Set(splitList(env.ALLOWED_EMAILS)),
    // Hosts an OAuth client may send tokens to, besides loopback (Claude Code on this machine).
    allowedRedirectHosts: new Set(splitList(env.ALLOWED_REDIRECT_HOSTS)),
    maxClients: Number(env.MAX_OAUTH_CLIENTS ?? 20),
    accessTeamDomain: String(env.ACCESS_TEAM_DOMAIN ?? '').trim(),
    accessAud: String(env.ACCESS_AUD ?? '').trim(),
    // Local `wrangler dev` has no Cloudflare Access in front of it. This stand-in identity is honored
    // only when both PUBLIC_ORIGIN and the request itself are on loopback (see access.mjs).
    devAccessEmail: isLocal
      ? String(env.DEV_ACCESS_EMAIL ?? '')
          .trim()
          .toLowerCase()
      : '',
    lockdown: env.LOCKDOWN === '1',
  };
}

export const isAllowedEmail = (config, email) =>
  typeof email === 'string' && config.allowedEmails.has(email.trim().toLowerCase());

// A redirect URI may go to an allowlisted https host or, for local clients, to loopback over http.
export function isAllowedRedirectUri(config, uri) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === 'http:') return isLoopbackHost(url.hostname);
  return url.protocol === 'https:' && config.allowedRedirectHosts.has(url.hostname.toLowerCase());
}
