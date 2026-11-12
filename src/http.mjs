// Response helpers shared by every route. Browser pages get a strict CSP with a per-response nonce for
// their one style block; nothing on them runs script.

const BASE_HEADERS = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-store',
};

export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

// Adds the headers every response carries, without overriding ones a route already set.
export function withSecurityHeaders(response) {
  // Redirects and some library responses are immutable; copy before editing.
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(BASE_HEADERS)) {
    if (!secured.headers.has(name)) secured.headers.set(name, value);
  }
  return secured;
}

function nonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

const STYLE = `
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 2rem auto; padding: 0 16px; color: #1d1d1f; background: #fff; }
  @media (prefers-color-scheme: dark) { body { color: #f2f2f2; background: #161618; } }
  button { font: inherit; padding: .5rem 1.25rem; margin-right: .5rem; border-radius: 8px; border: 1px solid #888; cursor: pointer; }
  button[value=approve] { background: #2f6f3e; color: #fff; border-color: #2f6f3e; }
  .warn { padding: .75rem; border-radius: 8px; background: #fff3cd; color: #5c4400; }
  code { word-break: break-all; }
`;

// Renders a page from trusted markup; callers escape anything that came from a request or a client.
// formActions lists the origins a form post may redirect to (browsers apply form-action to redirects).
export function htmlPage(title, bodyHtml, { status = 200, headers, formActions = [] } = {}) {
  const styleNonce = nonce();
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style nonce="${styleNonce}">${STYLE}</style></head>
<body>${bodyHtml}</body></html>`;
  const response = new Response(page, { status, headers });
  response.headers.set('Content-Type', 'text/html; charset=utf-8');
  response.headers.set(
    'Content-Security-Policy',
    `default-src 'none'; style-src 'nonce-${styleNonce}'; form-action ${["'self'", ...formActions].join(' ')}; frame-ancestors 'none'; base-uri 'none'`,
  );
  response.headers.set('X-Frame-Options', 'DENY');
  return response;
}

export const errorPage = (status, message) =>
  htmlPage('MTG Assistant', `<h1>Not allowed</h1><p>${escapeHtml(message)}</p>`, { status });

export const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });

export const clientIp = (request) => request.headers.get('CF-Connecting-IP') ?? 'unknown';
