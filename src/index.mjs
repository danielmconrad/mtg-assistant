// The Worker's entry point. Requests pass, in order: the lockdown switch, the route allowlist, the
// per-route rate limits, then the OAuth provider, which hands /mcp to the MCP handler with a verified
// token and everything else to the browser routes.
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { handleBrowserAuth } from './auth/flow.mjs';
import { registrationPolicy } from './auth/registration.mjs';
import { activeUser, logAuthEvent } from './auth/users.mjs';
import { isAllowedEmail, readConfig } from './config.mjs';
import { handleDownload } from './downloads.mjs';
import { clientIp, notFound, withSecurityHeaders } from './http.mjs';
import { handleMcpRequest } from './mcp/server.mjs';
import { matchRoute } from './routes.mjs';
import { handleUpload } from './uploads.mjs';

const ACCESS_TOKEN_TTL = 60 * 60;
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60;
// The largest MCP request body accepted: tool arguments are small, so anything bigger is refused.
const MAX_MCP_BODY_BYTES = 64 * 1024;
// Unused registered clients expire; one in use is renewed by the library. Longer than a grant lasts, so a
// working connection never loses its client.
const CLIENT_REGISTRATION_TTL = 60 * 24 * 60 * 60;
export const SCOPES = ['mcp'];

async function overLimit(env, binding, key) {
  const limiter = env[binding];
  if (!limiter) throw new Error(`Rate limiter ${binding} is not bound`);
  const { success } = await limiter.limit({ key });
  return !success;
}

const tooManyRequests = () =>
  new Response('Too many requests', { status: 429, headers: { 'Retry-After': '60', 'Content-Type': 'text/plain' } });

// /mcp: the provider has already validated the bearer token; this re-checks that its user is still
// invited and active, so removing an email or disabling a user takes effect on the next call.
const mcpHandler = {
  async fetch(request, env, ctx) {
    const config = readConfig(env);
    const props = ctx.props ?? {};
    const user = isAllowedEmail(config, props.email) ? await activeUser(env.DB, props) : null;
    if (!user) {
      await logAuthEvent(env.DB, request, 'token_refused', { email: props.email ?? null });
      return new Response(JSON.stringify({ error: 'invalid_token', error_description: 'Access has been revoked' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer error="invalid_token"' },
      });
    }
    if (await overLimit(env, 'RL_MCP', user.id)) return tooManyRequests();
    if (Number(request.headers.get('Content-Length') ?? 0) > MAX_MCP_BODY_BYTES) {
      return new Response('Request too large', { status: 413 });
    }
    const body = request.method === 'POST' ? await request.text() : null;
    if (body !== null && new TextEncoder().encode(body).length > MAX_MCP_BODY_BYTES) {
      return new Response('Request too large', { status: 413 });
    }
    const bounded = body === null ? request : new Request(request, { body });
    return handleMcpRequest(bounded, { id: user.id, email: user.email }, env);
  },
};

// Browser routes that aren't the provider's own endpoints.
const defaultHandler = {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/authorize' || pathname === '/callback') {
      return handleBrowserAuth(request, env, readConfig(env), pathname);
    }
    if (pathname === '/download') return handleDownload(request, env, readConfig(env));
    if (pathname === '/upload') return handleUpload(request, env, readConfig(env));
    return notFound();
  },
};

// Built per request so its callbacks close over this request's env; construction is cheap and the
// provider keeps no state between requests (it all lives in OAUTH_KV).
function buildProvider(env, config, auditLogs) {
  return new OAuthProvider({
    apiRoute: '/mcp',
    apiHandler: mcpHandler,
    defaultHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    accessTokenTTL: ACCESS_TOKEN_TTL,
    refreshTokenTTL: REFRESH_TOKEN_TTL,
    clientRegistrationTTL: CLIENT_REGISTRATION_TTL,
    scopesSupported: SCOPES,
    requiredScopes: SCOPES,
    resourceMetadata: {
      resource: `${config.origin}/mcp`,
      authorization_servers: [config.origin],
      bearer_methods_supported: ['header'],
      resource_name: 'MTG Assistant',
    },
    clientRegistrationCallback: registrationPolicy(env, config),
    // Token-endpoint failures (replayed codes, PKCE mismatches, revoked grants) are worth auditing.
    onError: ({ code, description, internal, request }) => {
      auditLogs.push(
        logAuthEvent(env.DB, request ?? null, 'oauth_error', {
          detail: { code, description, category: internal?.category, reason: internal?.reason },
        }),
      );
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const config = readConfig(env);
    const url = new URL(request.url);
    if (config.lockdown) return withSecurityHeaders(new Response('Temporarily unavailable', { status: 503 }));
    const route = matchRoute(url.pathname);
    if (!route) return withSecurityHeaders(notFound());
    if (!route.methods.includes(request.method)) {
      return withSecurityHeaders(
        new Response('Method not allowed', { status: 405, headers: { Allow: route.methods.join(', ') } }),
      );
    }
    if (route.limiter && (await overLimit(env, route.limiter, `${route.limiter}:${clientIp(request)}`))) {
      return withSecurityHeaders(tooManyRequests());
    }
    const auditLogs = [];
    const response = await buildProvider(env, config, auditLogs).fetch(request, env, ctx);
    if (auditLogs.length) ctx.waitUntil(Promise.allSettled(auditLogs));
    return withSecurityHeaders(response);
  },
};
