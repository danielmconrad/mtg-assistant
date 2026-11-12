// Policy for dynamic client registration (/register). Anyone on the internet can reach it, so it only
// stores clients whose every redirect URI is allowlisted. A registered client grants nothing by itself:
// using it still takes Cloudflare Access and Google sign-in. So there is no hard cap, which anyone could
// fill to lock claude.ai out; unusually many clients are flagged in the audit log instead, the per-IP
// rate limit slows floods, and unused clients expire (clientRegistrationTTL in src/index.mjs).
import { isAllowedRedirectUri } from '../config.mjs';
import { logAuthEvent } from './users.mjs';

async function countClients(kv, stopAt) {
  let count = 0;
  let cursor;
  do {
    const page = await kv.list({ prefix: 'client:', cursor });
    count += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && count < stopAt);
  return count;
}

export function registrationPolicy(env, config) {
  return async ({ clientMetadata, request }) => {
    const redirectUris = Array.isArray(clientMetadata.redirect_uris) ? clientMetadata.redirect_uris : [];
    const refused = redirectUris.filter((uri) => !isAllowedRedirectUri(config, uri));
    if (!redirectUris.length || refused.length) {
      await logAuthEvent(env.DB, request, 'registration_refused', {
        detail: {
          reason: 'redirect_uri',
          refused: refused.slice(0, 5),
          clientName: String(clientMetadata.client_name ?? '').slice(0, 100),
        },
      });
      return { code: 'invalid_redirect_uri', description: 'redirect_uri is not allowed', status: 400 };
    }
    const existing = await countClients(env.OAUTH_KV, config.clientAlertThreshold);
    if (existing >= config.clientAlertThreshold) {
      await logAuthEvent(env.DB, request, 'client_count_high', { detail: { atLeast: existing } });
    }
    await logAuthEvent(env.DB, request, 'client_registered', {
      detail: { clientName: String(clientMetadata.client_name ?? '').slice(0, 100), redirectUris },
    });
    return undefined;
  };
}
