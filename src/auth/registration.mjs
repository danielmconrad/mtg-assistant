// Policy for dynamic client registration (/register). Anyone on the internet can reach it, so it only
// stores clients whose every redirect URI is allowlisted, and only up to a fixed number of clients.
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
    if ((await countClients(env.OAUTH_KV, config.maxClients)) >= config.maxClients) {
      await logAuthEvent(env.DB, request, 'registration_refused', { detail: { reason: 'client_cap' } });
      return { code: 'access_denied', description: 'registration is closed', status: 403 };
    }
    await logAuthEvent(env.DB, request, 'client_registered', {
      detail: { clientName: String(clientMetadata.client_name ?? '').slice(0, 100), redirectUris },
    });
    return undefined;
  };
}
