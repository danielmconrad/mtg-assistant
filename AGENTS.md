# Agent Instructions

Read [README.md](README.md) first. This repo is a security-sensitive, internet-facing server, so the rules below
outrank convenience.

## Secrets and accounts

- Never read `.env` or `.env.worker` aloud, print their values, or paste them anywhere. Ask the user to fill them in
  themselves rather than accepting tokens in chat.
- `mise run setup:accounts` without `--apply` only reads. Run `--apply` only when the user asks, after they've
  seen the plan it prints.
- Don't deploy from a laptop. Production deploys come from CI on `main`. Don't run `wrangler deploy`,
  `wrangler secret put` or `wrangler d1 ... --remote` unless the user asks for that specific command.
- Don't commit, push or open pull requests without the user's permission.

## Changing the Worker

- Every new route goes in both `src/routes.mjs` (with its methods and rate limiter) and `PUBLIC_PATHS` in
  `scripts/setup-accounts.mjs`. A test fails if the two drift.
- Every new rate limiter needs a binding in `wrangler.jsonc`. Every new secret goes in `.env.example` or
  `.env.worker.example` with instructions for producing it, and never in `vars`.
- User identity comes only from the verified token (`ctx.props`), never from tool arguments. Every query on user
  data filters by that user, and every new tool gets a test that a second user can't see the first user's data.
- Escape everything from a request or an OAuth client before putting it in HTML (`escapeHtml` in
  `src/http.mjs`).
- D1 migrations are additive only, so a deploy can apply them before the new code is live.
- Record security-relevant outcomes with `logAuthEvent`. Never log tokens, secrets or purchase prices.

## Checks

- Run `mise run fix`, then `mise run ci` (lint, tests, scans) before calling a change done, and report any
  failure as it is.
- Tests stay offline: outbound calls are mocked (`tests/worker/helpers.mjs`), and test identities and keys are
  fakes.
- Pin new tools in `mise.toml` and new npm packages exactly (`npm install --save-exact --ignore-scripts`).
  Prefer no new dependency; if one is needed, choose a well-known package and say why.
