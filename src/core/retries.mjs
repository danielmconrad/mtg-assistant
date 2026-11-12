// Retries for outbound requests (EDHREC now; Scryfall's per-card API later). Ported from mtg-manager's
// scripts/scryfall.mjs, with a Web-standard pause so it runs in Workers as well as Node.

// A rate limit (429), a server error or a dropped connection is retried after each of these pauses,
// or after the service's Retry-After when it sends one (capped at a minute).
const RETRY_PAUSES_MS = [1000, 2000, 4000];
const MAX_RETRY_AFTER_MS = 60_000;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryable = (status) => status === 429 || status >= 500;

function retryAfterMs(response) {
  const seconds = Number(response?.headers?.get?.('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : undefined;
}

// Sends a request, retrying rate limits, server errors and network failures. The last response is
// returned whatever its status, so callers report it; the last network failure is thrown, naming the
// service (edhrec.mjs uses this too).
export async function withRetries(send, pause, service = 'Scryfall') {
  for (let attempt = 0; ; attempt += 1) {
    let response;
    let failure;
    try {
      response = await send();
    } catch (error) {
      failure = error;
    }
    const retryable = failure !== undefined || isRetryable(response.status);
    if (!retryable || attempt === RETRY_PAUSES_MS.length) {
      if (failure) {
        throw new Error(`${service} request failed (${failure.message}); nothing was changed. Retry later.`);
      }
      return response;
    }
    await pause(retryAfterMs(response) ?? RETRY_PAUSES_MS[attempt]);
  }
}
