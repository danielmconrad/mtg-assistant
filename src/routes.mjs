// Every path the Worker answers, with its methods and the rate limiter guarding it. Anything else is a
// 404 here, and the WAF rule from scripts/setup-accounts.mjs blocks it before it reaches the Worker
// (tests/node/setup-accounts.test.mjs keeps the two lists in step). No imports, so Node tests can load it.
// OPTIONS lets browser-based MCP clients (such as MCP Inspector) send CORS preflights, which the OAuth
// library answers; /authorize and /callback are page navigations, so they never get one.
export const ROUTES = [
  { path: '/.well-known/oauth-authorization-server', methods: ['GET', 'OPTIONS'], limiter: 'RL_PUBLIC' },
  { path: '/.well-known/oauth-protected-resource', prefix: true, methods: ['GET', 'OPTIONS'], limiter: 'RL_PUBLIC' },
  { path: '/register', methods: ['POST', 'OPTIONS'], limiter: 'RL_REGISTER' },
  { path: '/token', methods: ['POST', 'OPTIONS'], limiter: 'RL_AUTH' },
  { path: '/authorize', methods: ['GET', 'POST'], limiter: 'RL_AUTH' },
  { path: '/callback', methods: ['GET'], limiter: 'RL_AUTH' },
  // A signed collection download (src/downloads.mjs), opened in a browser behind Cloudflare Access.
  { path: '/download', methods: ['GET'], limiter: 'RL_DOWNLOAD' },
  // The upload page (src/uploads.mjs), from a signed link, behind Cloudflare Access: GET shows the form,
  // POST previews a file or applies a previewed one.
  { path: '/upload', methods: ['GET', 'POST'], limiter: 'RL_UPLOAD' },
  // /mcp is limited per user inside the handler, since Anthropic's servers share IPs.
  { path: '/mcp', methods: ['GET', 'POST', 'DELETE', 'OPTIONS'] },
];

export const matchRoute = (pathname) =>
  ROUTES.find((route) => pathname === route.path || (route.prefix && pathname.startsWith(`${route.path}/`)));
