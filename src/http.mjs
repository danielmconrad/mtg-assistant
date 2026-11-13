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

// mtg-manager's full-art card look (its HTML lists): smoky charcoal art behind everything, and the page
// as one card, a lighter smoke panel with its heading in a chrome-bevelled parchment name bar inset at
// the top and light text on the art below, then a credit line along the bottom. Fonts come from Google Fonts and the bar's mottling is an inline SVG,
// which the CSP allows for these and nothing else.
const FONTS_CSS =
  'https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,400;0,600;0,700;1,400&family=Spectral:wght@700;800&display=swap';
const STYLE = `
  :root { color-scheme: dark; --smoke-1: #1d1f22; --smoke-2: #2e3034; --smoke-3: #4a4d53; --mist: #c9ccd2; --silver: #9da2aa;
    --white: #f4f1ea; --text: #dcd8d0; --parch-hi: #f3eee2; --ink: #17140f; --ember: #e8843a; --pad: 16px;
    --display: 'Spectral', 'Crimson Pro', Georgia, serif; --serif: 'Crimson Pro', Georgia, 'Times New Roman', serif; }
  @media (min-width: 600px) { :root { --pad: 24px; } }
  html { -webkit-text-size-adjust: 100%; }
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; background: #121315; color: var(--white); font: 400 18px/1.45 var(--serif); }
  /* The "art": smoke, a cold flash of light from the upper right and a few embers low left. */
  body::before { content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none;
    background:
      radial-gradient(2px 2px at 8% 82%, rgba(240, 150, 70, 0.9), transparent 70%),
      radial-gradient(3px 3px at 14% 74%, rgba(240, 150, 70, 0.75), transparent 70%),
      radial-gradient(2px 2px at 5% 64%, rgba(240, 150, 70, 0.6), transparent 70%),
      radial-gradient(2px 2px at 21% 88%, rgba(240, 150, 70, 0.7), transparent 70%),
      radial-gradient(3px 3px at 92% 92%, rgba(240, 150, 70, 0.55), transparent 70%),
      radial-gradient(2px 2px at 86% 70%, rgba(240, 150, 70, 0.45), transparent 70%),
      radial-gradient(900px 520px at 88% -8%, rgba(205, 215, 235, 0.2), transparent 62%),
      radial-gradient(700px 480px at -5% 105%, rgba(232, 132, 58, 0.13), transparent 60%),
      radial-gradient(600px 600px at 30% 40%, rgba(90, 95, 105, 0.22), transparent 70%),
      linear-gradient(180deg, #2a2c30 0%, #1d1e21 48%, #111214 100%); }
  .wrap { max-width: 720px; margin: 0 auto; padding: 0 var(--pad); }
  header.wrap { padding-top: 22px; padding-bottom: 2px; }
  .eyebrow { margin: 0 0 12px; font: 600 0.8rem/1.3 var(--serif); letter-spacing: 0.14em; text-transform: uppercase; color: var(--mist); }
  /* Name bar: a chrome bevel running white to charcoal, with elliptical ends, around mottled parchment. */
  .frame { --bevel: 3px; --rx: 0.6em; --band: 2.5px; --side: 5px; padding: var(--bevel); font-size: clamp(1.3rem, 5vw, 1.6rem);
    border-radius: var(--rx) / 50%;
    background: linear-gradient(90deg, #fefefe 0%, #fdfdfd 26%, #d5d5d8 38%, #939393 50%, #515152 61%, #2b2c2c 70%, #242424 100%);
    box-shadow: 0 0 0 1.5px #0d0d0d, 0 2px 6px rgba(0, 0, 0, 0.45); }
  .plaque { padding: 0.25em 0.5em calc(0.22em + var(--band)); color: var(--ink); border-radius: calc(var(--rx) - var(--bevel)) / 50%;
    background:
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='120'%3E%3Cfilter id='m'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.035 0.09' numOctaves='3' seed='7' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.36 0 0 0 0 0.31 0 0 0 0 0.24 0 0 0 0.32 -0.05'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23m)'/%3E%3C/svg%3E"),
      linear-gradient(180deg, rgba(255, 255, 255, 0.22) 0%, rgba(255, 255, 255, 0) 30%),
      linear-gradient(180deg, rgba(70, 58, 40, 0) 45%, rgba(70, 58, 40, 0.14) 100%),
      linear-gradient(90deg, #ece9dd 0%, #e9e5d7 26%, #e1ddd0 36%, #d7d3c9 48%, #cac2b8 58%, #c2b8ad 68%, #bfb4a8 84%, #c2b7ab 100%);
    box-shadow:
      inset 0 0 0 1.5px #0a0807,
      inset 0 2.5px 0 0 rgba(255, 253, 245, 0.9),
      inset 0 calc(-1.5px - var(--band)) 0 0 #433e37,
      inset 0 calc(-3px - var(--band)) 2px -0.5px rgba(70, 62, 52, 0.5),
      inset calc(-1 * var(--side)) 0 5px -2px rgba(255, 251, 243, 0.6),
      inset var(--side) 0 5px -2px rgba(28, 24, 20, 0.7); }
  h1 { margin: 0; font: 800 1em/1.1 var(--display); letter-spacing: -0.005em; overflow-wrap: anywhere; }
  /* The card: a lighter smoke panel holding the name bar and, below it, the page on the art. */
  .card { padding: 8px 8px 4px; border-radius: 14px; overflow-wrap: anywhere;
    background:
      radial-gradient(260px 120px at 92% 0%, rgba(205, 215, 235, 0.14), transparent 70%),
      linear-gradient(160deg, var(--smoke-3) 0%, var(--smoke-2) 38%, var(--smoke-1) 100%);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35); }
  .card-body { margin: 14px 10px 12px; color: var(--text); }
  .card-body h2 { margin: 20px 0 8px; font: 800 1.2rem/1.2 var(--display); color: var(--parch-hi); }
  .card-body strong, .card-body b { color: var(--white); }
  p { margin: 0 0 12px; }
  ul, ol { margin: 0 0 12px; padding-left: 1.3em; }
  li { margin-bottom: 5px; }
  li::marker { color: var(--silver); }
  code { font-size: 0.88em; color: var(--white); background: rgba(0, 0, 0, 0.3); padding: 0 4px; border-radius: 3px; word-break: break-all; }
  code.url { display: block; margin: 6px 0 8px; padding: 8px 10px; font: 0.85rem/1.4 ui-monospace, Menlo, Consolas, monospace;
    border: 1px solid rgba(201, 204, 210, 0.18); user-select: all; }
  label { display: block; margin: 6px 0; }
  /* A choice: its radio, a short label, and a quieter line of detail below. */
  .choice { display: grid; grid-template-columns: auto 1fr; gap: 0 10px; align-items: baseline; margin: 10px 0; cursor: pointer; }
  .choice input { margin: 0; width: 1.1rem; height: 1.1rem; accent-color: var(--ember); transform: translateY(0.15rem); }
  .choice b { font-weight: 600; }
  .choice small { display: block; font-size: 0.86rem; line-height: 1.35; color: var(--silver); }
  fieldset { margin: 0 0 14px; padding: 0; border: 0; }
  legend { padding: 0; margin-bottom: 2px; font: 600 0.8rem/1.3 var(--serif); letter-spacing: 0.12em; text-transform: uppercase; color: var(--mist); }
  input:not([type=radio]):not([type=hidden]) { display: block; width: 100%; margin-top: 4px; padding: 8px 10px; font: inherit; color: var(--white);
    background: rgba(0, 0, 0, 0.28); border: 1px solid rgba(201, 204, 210, 0.25); border-radius: 6px; }
  /* Buttons: ember pills; the main action is filled. */
  form p:has(> button) { display: flex; flex-wrap: wrap; gap: 10px; }
  button { flex: 1 1 9rem; min-height: 46px; padding: 8px 18px; font: 700 1rem/1 var(--serif); color: var(--ember); cursor: pointer;
    background: transparent; border: 1.5px solid var(--ember); border-radius: 999px; }
  button:hover { background: rgba(232, 132, 58, 0.16); }
  button[value=approve], form > p > button:only-child { color: #1a120b; background: var(--ember); }
  button[value=approve]:hover, form > p > button:only-child:hover { background: #f09550; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--white); outline-offset: 2px; }
  .warn { padding: 10px 12px; border-left: 3px solid var(--ember); border-radius: 4px; background: rgba(232, 132, 58, 0.13); color: var(--parch-hi); }
  /* Credit: the card's bottom legal line. */
  .credit { margin: 20px 4px 30px; font-size: 0.85rem; color: var(--mist); letter-spacing: 0.02em; }
  .credit p { margin: 0; }
  .credit b { font-variant: small-caps; letter-spacing: 0.06em; color: var(--white); }
`;

// Renders a page from trusted markup; callers escape anything that came from a request or a client.
// formActions lists the origins a form post may redirect to (browsers apply form-action to redirects).
export function htmlPage(title, bodyHtml, { status = 200, headers, formActions = [] } = {}) {
  const styleNonce = nonce();
  // A leading <h1> becomes the card's name bar; the rest goes below it.
  const [, heading = '', rest = bodyHtml] = /^\s*(<h1>[\s\S]*?<\/h1>)([\s\S]*)$/.exec(bodyHtml) ?? [];
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><link rel="stylesheet" href="${FONTS_CSS}">
<style nonce="${styleNonce}">${STYLE}</style></head>
<body><header class="wrap"><p class="eyebrow">MTG Assistant</p></header>
<main class="wrap"><article class="card">${heading ? `<div class="frame"><div class="plaque">${heading}</div></div>` : ''}<div class="card-body">${rest}</div></article>
<footer class="credit"><p><b>MTG Assistant</b> · your collection and decks, in Claude</p></footer></main></body></html>`;
  const response = new Response(page, { status, headers });
  response.headers.set('Content-Type', 'text/html; charset=utf-8');
  response.headers.set(
    'Content-Security-Policy',
    `default-src 'none'; style-src 'nonce-${styleNonce}' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; form-action ${["'self'", ...formActions].join(' ')}; frame-ancestors 'none'; base-uri 'none'`,
  );
  response.headers.set('X-Frame-Options', 'DENY');
  return response;
}

export const errorPage = (status, message) =>
  htmlPage('MTG Assistant', `<h1>Not allowed</h1><p>${escapeHtml(message)}</p>`, { status });

export const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });

export const clientIp = (request) => request.headers.get('CF-Connecting-IP') ?? 'unknown';
