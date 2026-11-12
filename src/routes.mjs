// Every path the Worker answers, with its methods and the rate limiter guarding it. Anything else is a
// 404 here, and the WAF rule from scripts/setup-accounts.mjs blocks it before it reaches the Worker
// (tests/node/setup-accounts.test.mjs keeps the two lists in step). No imports, so Node tests can load it.
export const ROUTES = [
  { path: '/.well-known/oauth-authorization-server', methods: ['GET'], limiter: 'RL_PUBLIC' },
  { path: '/.well-known/oauth-protected-resource', prefix: true, methods: ['GET'], limiter: 'RL_PUBLIC' },
  { path: '/register', methods: ['POST'], limiter: 'RL_REGISTER' },
  { path: '/token', methods: ['POST'], limiter: 'RL_AUTH' },
  { path: '/authorize', methods: ['GET', 'POST'], limiter: 'RL_AUTH' },
  { path: '/callback', methods: ['GET'], limiter: 'RL_AUTH' },
  // /mcp is limited per user inside the handler, since Anthropic's servers share IPs.
  { path: '/mcp', methods: ['GET', 'POST', 'DELETE'] },
];

export const matchRoute = (pathname) =>
  ROUTES.find((route) => pathname === route.path || (route.prefix && pathname.startsWith(`${route.path}/`)));
