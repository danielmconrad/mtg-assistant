// The browser half of the OAuth flow: the consent page at /authorize and Google's return to /callback.
// Every step re-checks the Cloudflare Access identity, and the Google account must be the same person.
import { AuthorizationError, CimdFetchError, authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider';
import { isAllowedEmail, isAllowedRedirectUri } from '../config.mjs';
import { errorPage, escapeHtml, htmlPage } from '../http.mjs';
import { verifyAccess } from './access.mjs';
import { authorizeUrl, exchangeCode, randomToken, s256 } from './google.mjs';
import { logAuthEvent, signInUser } from './users.mjs';

const GOOGLE_ORIGIN = 'https://accounts.google.com';

function redirect(location, headers = new Headers()) {
  headers.set('Location', location);
  return new Response(null, { status: 302, headers });
}

function consentPage(details, handle, email) {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : 'This app registered itself, so its name is not verified.';
  const loopback = details.redirectIsLoopback
    ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it, such as Claude Code.</p>'
    : '';
  return `<h1>Allow ${name} to use MTG Assistant?</h1>
<p>Signed in as <strong>${escapeHtml(email)}</strong>. Next you'll confirm with Google.</p>
<p>${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopback}
<form method="post" action="/authorize">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <p><button name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button></p>
</form>`;
}

async function refuse(env, request, type, message, detail) {
  await logAuthEvent(env.DB, request, type, detail);
  return errorPage(403, message);
}

async function showConsent(request, env, config, access) {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest);
  // Only known clients get this far: claude.ai's connector callback, or a local app on loopback.
  if (!isAllowedRedirectUri(config, details.redirectUri)) {
    return refuse(env, request, 'redirect_refused', 'This app is not allowed to connect.', {
      email: access.email,
      detail: { redirectHost: details.redirectHost, clientName: details.clientName },
    });
  }
  const consent = await oauth.beginConsent(authRequest);
  const redirectOrigin = new URL(details.redirectUri).origin;
  return htmlPage('Authorize MTG Assistant', consentPage(details, consent.handle, access.email), {
    headers: consent.headers,
    formActions: [GOOGLE_ORIGIN, redirectOrigin],
  });
}

async function decideConsent(request, env, config, access) {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get('handle') ?? '');
  if (form.get('decision') !== 'approve') {
    const denied = await oauth.denyConsent(request, handle);
    await logAuthEvent(env.DB, request, 'consent_denied', { email: access.email });
    return redirect(denied.redirectTo, denied.headers);
  }
  const approved = await oauth.approveConsent(request, handle);
  const verifier = randomToken();
  const nonce = randomToken();
  const { state, headers } = await oauth.beginUpstream(approved.request, {
    data: { verifier, nonce, accessEmail: access.email },
    headers: approved.headers,
  });
  const location = authorizeUrl(env, config, {
    state,
    codeChallenge: await s256(verifier),
    nonce,
    loginHint: access.email,
  });
  return redirect(location, headers);
}

async function finishSignIn(request, env, config, access) {
  const oauth = env.OAUTH_PROVIDER;
  const { request: original, data, headers } = await oauth.finishUpstream(request);
  const params = new URL(request.url).searchParams;
  if (params.get('error') || !params.get('code')) {
    await logAuthEvent(env.DB, request, 'google_declined', {
      email: access.email,
      detail: { error: params.get('error') },
    });
    return redirect(authorizationErrorRedirect(original, 'access_denied'), headers);
  }
  const google = await exchangeCode(env, config, {
    code: params.get('code'),
    verifier: data.verifier,
    nonce: data.nonce,
  });
  if (google.problem) {
    return refuse(env, request, 'login_failed', 'Google sign-in failed.', {
      email: access.email,
      detail: google.problem,
    });
  }
  // The Google account must be allowlisted and be the same person Access let in.
  if (!isAllowedEmail(config, google.email)) {
    return refuse(env, request, 'email_denied', 'This Google account is not invited.', { email: google.email });
  }
  if (google.email !== access.email || google.email !== data.accessEmail) {
    return refuse(
      env,
      request,
      'identity_mismatch',
      'Sign in to Google with the same account you used for Cloudflare Access.',
      {
        email: google.email,
        detail: { accessEmail: access.email },
      },
    );
  }
  const { user, problem, claimed } = await signInUser(env.DB, google);
  if (problem) return refuse(env, request, 'login_failed', problem, { email: google.email });
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: user.id,
    metadata: { email: user.email },
    scope: original.scope,
    props: { userId: user.id, email: user.email, sub: user.google_sub },
  });
  if (claimed) await logAuthEvent(env.DB, request, 'account_claimed', { email: user.email });
  await logAuthEvent(env.DB, request, 'login_success', { email: user.email, detail: { clientId: original.clientId } });
  return redirect(redirectTo, headers);
}

const BROWSER_ROUTES = {
  'GET /authorize': showConsent,
  'POST /authorize': decideConsent,
  'GET /callback': finishSignIn,
};

async function authorizationFailure(error, env, request, access) {
  // Redirect only when the library has validated the client and its exact redirect URI.
  if (error instanceof AuthorizationError && error.redirectTo) return redirect(error.redirectTo);
  if (!(error instanceof AuthorizationError || error instanceof CimdFetchError)) throw error;
  await logAuthEvent(env.DB, request, 'authorize_error', {
    email: access.email,
    detail: error.description ?? error.message,
  });
  return errorPage(400, error instanceof AuthorizationError ? error.description : 'This app could not be verified.');
}

// Handles /authorize (GET shows consent, POST decides) and /callback.
export async function handleBrowserAuth(request, env, config, pathname) {
  const access = await verifyAccess(request, config);
  if (access.problem) {
    return refuse(env, request, 'access_denied', 'Sign in through Cloudflare Access first.', {
      detail: access.problem,
    });
  }
  const handler = BROWSER_ROUTES[`${request.method} ${pathname}`];
  if (!handler) return new Response('Method not allowed', { status: 405 });
  try {
    return await handler(request, env, config, access);
  } catch (error) {
    return authorizationFailure(error, env, request, access);
  }
}
