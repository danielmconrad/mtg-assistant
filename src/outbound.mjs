// Every request the Worker makes to another site on a person's behalf goes through here. Only these
// hosts are reachable, over HTTPS, and a redirect is followed only to another of them, so no tool can
// be turned into a way to fetch arbitrary URLs. There is no generic "fetch a URL" tool.
export const OUTBOUND_HOSTS = ['json.edhrec.com', 'archidekt.com'];
const MAX_REDIRECTS = 3;
// The most a response may hold; EDHREC pages and Archidekt decks are well under this.
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class OutboundRefused extends Error {}

function allowedUrl(input) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || !OUTBOUND_HOSTS.includes(url.hostname) || url.port || url.username) {
    throw new OutboundRefused(`Requests to ${url.hostname} are not allowed`);
  }
  return url;
}

// fetch, restricted to the allowlist. Redirects are followed by hand so each hop is checked.
export async function outboundFetch(input, init = {}) {
  let url = allowedUrl(input);
  for (let hop = 0; ; hop += 1) {
    const response = await fetch(url, { ...init, redirect: 'manual' });
    const location = response.headers.get('Location');
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response;
    if (hop === MAX_REDIRECTS) throw new OutboundRefused('Too many redirects');
    url = allowedUrl(new URL(location, url));
  }
}

// A response's JSON, refusing bodies over MAX_RESPONSE_BYTES.
export async function boundedJson(response) {
  if (Number(response.headers.get('Content-Length') ?? 0) > MAX_RESPONSE_BYTES) {
    throw new OutboundRefused('The response is too large');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new OutboundRefused('The response is too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
