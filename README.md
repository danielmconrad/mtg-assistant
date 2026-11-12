# MTG Assistant

A private, invite-only remote MCP server for managing Magic: The Gathering collections and building decks,
usable from the Claude mobile, web and desktop apps and from Claude Code. It replaces the local
[mtg-manager](https://github.com/danielmconrad/mtg-manager) CLI with a Cloudflare Worker at
`https://mtg-assistant.conrad.tools`.

**Status:** step 2 of the plan. The server signs people in and serves one tool, `whoami`, and every card on
Scryfall is loaded into D1 nightly. Card search, collections and decks come next.

## How it fits together

```
Claude (any app) ──MCP over HTTPS──▶ Cloudflare edge (WAF, rate limit) ──▶ Worker /mcp
                                                                            │ OAuth 2.1 bearer token
Your browser ──▶ Cloudflare Access (Google) ──▶ Worker /authorize, /callback│ Google sign-in
                                                                            ▼
                                                              D1 (users, audit log), KV (OAuth state)
```

- **One Worker** (`src/index.mjs`) serves the OAuth endpoints from
  [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) and a stateless
  MCP endpoint from the MCP SDK's web-standard Streamable HTTP transport.
- **Signing in** takes three independent checks against the same allowlist: Cloudflare Access in front of the
  browser pages, Google sign-in (whose OAuth app is in Testing mode, with only invited test users), and the
  Worker's own `ALLOWED_EMAILS`. The Google account must be the same person Access let in, and its Google ID is
  pinned at first sign-in.
- **Every `/mcp` call** re-checks that the token's user is still invited and active, so removing an email takes
  effect on the next call.

## Setup

Everything runs through [mise](https://mise.jdx.dev); nothing else is installed globally.

```sh
mise trust && mise install        # node, gh, wrangler and the scanners, at pinned versions
mise run setup                    # npm ci and the pre-commit hook (gitleaks, eslint, prettier)
cp .env.example .env              # then follow the instructions inside to fill it in
mise run setup:accounts           # shows what it would create or change in Cloudflare and GitHub
mise run setup:accounts -- --apply
```

Then:

1. Commit the `wrangler.jsonc` changes `setup:accounts` made (resource IDs, Access settings) and merge to `main`.
   CI deploys once lint, tests and scans pass.
2. Run `mise run setup:accounts -- --apply` again. Worker secrets can only be set once the Worker exists.
3. In Claude (Settings → Connectors → Add custom connector), add `https://mtg-assistant.conrad.tools/mcp`, sign
   in, and ask Claude to run `whoami`.

## Local development

```sh
cp .env.worker.example .env.worker   # local Worker secrets; see the comments inside
mise run db:migrate:local
mise run ingest:local              # every Scryfall card into the local database (about 107 MB download)
mise run dev                      # http://localhost:8787
mise run inspector                # MCP Inspector, to call the tools
```

wrangler is configured (in `mise.toml`) never to load `.env` into the local Worker, so admin tokens stay out of
it.

## Tasks

| Task                        | What it does                                                                   |
| --------------------------- | ------------------------------------------------------------------------------ |
| `mise run test`             | Unit, integration and security tests: workerd for the Worker, Node for scripts |
| `mise run lint` / `fix`     | ESLint, Prettier, actionlint and zizmor                                        |
| `mise run scan`             | npm audit and signatures, OSV-Scanner, lockfile-lint, Semgrep, gitleaks        |
| `mise run ci`               | lint, test and scan, as CI runs them                                           |
| `mise run setup:accounts`   | Plans (or with `-- --apply`, makes) the Cloudflare and GitHub configuration    |
| `mise run dev`              | Local Worker with local D1, KV and rate limiters                               |
| `mise run ingest:local`     | Load every Scryfall card into the local database                               |
| `mise run check:production` | The post-deploy security checks, run against production                        |
| `mise run auth:lockdown`    | Kill switch: production answers 503 everywhere                                 |
| `mise run auth:unlock`      | Turns the kill switch off, then runs `check:production`                        |

## Card data

Every card on Scryfall lives in D1:

- **`cards`:** rules text, color identity as a bitmask, legality, and EDHREC rank, with one row per card.
- **`printings`:** set, collector number, rarity and whether it's the default printing, with one row per printing.
- **`prices`:** USD, foil, etched and EUR prices.
- **`cards_fts`:** a full-text index over names, type lines and rules text.

`.github/workflows/scryfall.yml` runs `scripts/ingest-scryfall.mjs --remote` every day at 11:17 UTC, after
Scryfall rebuilds its bulk files, and can also be started by hand from the Actions tab. It uses a token that can
only edit D1. Each run streams the same two bulk files mtg-manager used, compares every row's hash with what's
already in D1, and writes only what changed. A run with no changes writes one metadata row. It stops rather than
delete more than 2% of a table, since that would point to a bad download.

## Deploys

Deploys happen only from GitHub Actions (`.github/workflows/ci.yml`), only from `main`, and only after
the `lint`, `test` and `scan` jobs pass. The deploy job:

1. Applies D1 migrations, which a test keeps additive-only.
2. Deploys the Worker.
3. Runs `scripts/post-deploy-check.mjs` against production. It checks what can only be seen live: unknown
   paths are blocked at the edge, Access guards the browser routes, `/register` is rate limited, `/mcp` refuses
   anonymous calls, and workers.dev and preview URLs are off.
4. Rolls back if anything fails. If there's no earlier version, as on the first deploy, it turns on `LOCKDOWN`
   instead.

A weekly workflow reruns the scans, and Dependabot proposes grouped updates after a 7-day cooldown.

## Security in brief

- **Edge:**
  - Only the custom domain serves the Worker; workers.dev and preview URLs are off.
  - A WAF rule blocks every path the Worker doesn't serve.
  - A per-IP edge rate limit sits in front.
- **Worker:**
  - Keeps its own route allowlist.
  - Applies per-route rate limits, per IP on the auth endpoints and per user on `/mcp`.
  - Sets security headers on every response, with a strict CSP on its HTML.
  - Has a `LOCKDOWN` switch.
- **OAuth:**
  - Clients can only register if every redirect URI is claude.ai, claude.com or loopback. Registering grants
    nothing on its own (using a client still takes Access and Google), so there's no hard cap that someone
    could fill to lock claude.ai out. Instead, registration is rate limited per IP, unusually many clients are
    flagged in the audit log, and unused clients expire after 60 days.
  - PKCE S256 is required, and authorization codes are single-use.
  - Access tokens last one hour.
  - Refresh tokens rotate. The previous one keeps working only until its replacement is first used, and the
    grant ends after 30 days.
- **Audit:** sign-ins, refusals, client registrations and token errors are written to `auth_events` in D1.

## Agents

[AGENTS.md](AGENTS.md) has the rules for AI agents working in this repo.
