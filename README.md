# MTG Assistant

A private, invite-only remote MCP server for managing Magic: The Gathering collections and building decks,
usable from the Claude mobile, web and desktop apps and from Claude Code. It replaces the local
[mtg-manager](https://github.com/danielmconrad/mtg-manager) CLI with a Cloudflare Worker at
`https://mtg-assistant.conrad.tools`.

**Status:** Milestone 1 (read-only) is complete. Every card on Scryfall is loaded into D1 nightly, mtg-manager's
logic is ported to `src/core`, each person's collections and decks live in D1, and these read-only tools are
live: `search_cards`, `get_cards`, `collection_summary`, `rank_commanders`, `list_decks`, `show_deck`,
`deck_stats`, `check_deck`, `export_deck`, `get_download_link`, `get_workflow` and `whoami`. Milestone 2 (writes)
is under way: decks can be created, edited, verified and priced, collections changed by text list, and decks
built, torn down and swapped physically; the upload page comes next.

## Tools

Each tool is mtg-manager's command of the same purpose, and answers with that command's text output:

- **`search_cards`** (`collection:search`): searches the person's collection by default. It can also search
  cards they don't own (`scope: unowned`) or every card (`scope: all`), using the same filters, `count` and
  `group_by`. Unowned and all-cards searches are narrowed in SQL first, by a filter that may only keep more
  cards than the search would, never fewer. A test checks that on 1,152 filter combinations. Mtg-manager's own
  filters then decide, and a search that would still load over 4,000 cards asks for narrower filters.
- **`get_cards`** (`card:show`): shows any card by name, owned or not. Misspellings get suggestions from every
  card's name.
- **`collection_summary`** (`collection:check`): lists the person's collections, how fresh the card data is, and
  any rows that match no printing.
- **`rank_commanders`** (`collection:commanders`): ranks every Commander-legal commander, owned or not, by how much
  of the collection feeds its themes, compared with an average collection.
  - **What gets precomputed:** that comparison needs every Commander-legal card (about 32,000). The nightly
    ingest stores what each one adds (its themes and creature types) in `commander_pool`, and the creature-type
    list in `card_data_meta`.
  - **What a call loads:** that compact table, plus full card data only for the candidates and the person's own
    cards.
  - **Parity:** a test checks that the result equals mtg-manager's ranking over the full card set.
- **`list_decks`**, **`show_deck`**, **`deck_stats`**, **`check_deck`** and **`export_deck`** (`deck:show`,
  `deck:stats`, `deck:check`, `deck:export`): the person's decks.
- **`verify_deck`**, **`deck_candidates`** and **`deck_upgrades`** (`deck:verify`, `deck:candidates`,
  `deck:upgrades`): whether a deck is ready to hand off, the strong cards it leaves out, and what it still needs
  to buy against its budget. With no decklist files on the server, `verify_deck` skips that check.
- **`create_deck`** and **`update_deck`** (`deck:new`, `deck:swap` and hand edits to `deck.yaml`): a new draft
  from the brief, and changes as a list of operations (add, remove, swap, set_role, set_commanders, consider,
  upgrades, history, playtests, and `set` for the deck's fields), all saved together or not at all.
  - **Card names** are checked against the card data and saved in its spelling; unknown ones get suggestions.
  - **Swaps** go through mtg-manager's own `withMainboardSwaps`, so the reason and history are recorded as
    `deck:swap` recorded them.
  - **Every save** is validated against the deck schema (and the upgrades must still apply), records
    `lowest_legal_bracket` from the cards, and removes a `plays_like_bracket` judged for an older card list,
    as `deck:files` did.
  - **Built decks** keep their card list; only `build_deck` makes a deck built, and `swap_deck` changes its list.
  - **Concurrent edits:** a save is refused if the deck changed since it was read, so two edits can't
    silently overwrite each other.
- **`add_cards`**, **`remove_cards`** and **`collection_changes`**: change one collection from a short text list
  (`2 Sol Ring (C21) 263 *F*`), and see what changed since a date (`collection:diff`, from a log rather than Git).
  - **Lines** must each match a card, and a set and number pin the printing. Adding joins a row of the same
    printing and finish; removing by name alone works only when the collection holds one printing of it.
    Nothing changes unless every line can be applied.
  - **New text lists** start with `create: true`, protected in `precons`, `decks` and `protected` folders as
    migrated ones are. A built deck's own list changes only with its deck.
  - **One transaction per change:** each change is one D1 batch. A guard moves every touched collection from
    the revision it was read at to a new one, and each other statement applies only if all the guards did,
    so two changes at once can't both apply to the same starting point.
  - **The log:** each change writes one `collection_events` row per card, with the tool, an optional note and
    a batch ID. Purchase prices are never logged.
- **`build_deck`**, **`teardown_deck`** and **`swap_deck`** (`deck:build`, `deck:teardown`, `deck:swap` on a
  built deck): move a deck's real cards when the person says they've sleeved, unsleeved or swapped them.
  - **Plan first:** each shows the copies it would move and changes nothing unless called with `apply: true`.
  - **Building** needs the deck to pass `check_deck` with non-proxy copies. It takes them with mtg-manager's
    `planBuild` (pinned printing, then nonfoil, then the most-held printing) into a new text list of its own,
    `decks/<slug>` by default, and names drafts that may come up short. Untracked basics are listed by name.
  - **Tearing down** returns the list's cards to `to` (lands to `lands_to`), deletes the list and makes the deck
    a draft again. **Swapping** moves each in card from the other collections into the list and each out card
    back to `to`, recording the swap as `update_deck` does; the swapped deck must still pass `check_deck`.
  - **One transaction:** every touched collection and the deck itself are guarded by revision in one D1 batch,
    so a move applies whole or not at all, and the log records it under the tool's name.
- **`get_download_link`**: a link to one collection, or every collection as a zip with a `manifest.json`, as a
  ManaBox CSV (every column it was imported with, so it reads back), a Moxfield CSV or a text list. Purchase
  prices are left out unless asked for. The link (`/download?token=...`) is HMAC-signed with
  `DOWNLOAD_SIGNING_KEY` (`src/links.mjs`), expires after 15 minutes and works three times, counted in D1's
  `link_uses`. Cloudflare Access guards it, and the Access identity must be the link's own person. The file is
  built when the link is opened and never stored. Each download or refusal is written to `auth_events`.
- **`get_workflow`**: mtg-manager's skills as playbooks rewritten for these tools (`src/mcp/workflows/`):
  `new-deck`, `collection-survey`, `commander-scout`, `deck-review`, `deck-upgrades`, `deckbuilding-strategy` and
  `formats`. Each is also an MCP prompt, and the server instructions point Claude to them.

How the tools handle safety and input:

- **The user:** every tool takes the user from the verified token, never from its arguments.
- **Argument checks:** arguments are validated strictly, with unknown fields refused and every string and list
  bounded. Request bodies over 64 KB are refused.
- **Regexes:** user regexes are capped at 200 characters, and nested quantifiers and backreferences are
  refused.
- **Isolation:** `tests/worker/tools.test.mjs` calls every tool as a second person and requires that they see
  none of the first person's data. It fails if a tool is added without that check.

## How it fits together

```
Claude (any app) ──MCP over HTTPS──▶ Cloudflare edge (WAF, rate limit) ──▶ Worker /mcp
                                                                            │ OAuth 2.1 bearer token
Your browser ──▶ Cloudflare Access (Google) ──▶ Worker /authorize, /callback│ Google sign-in
                                                 Worker /download           │ signed link
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

## Code layout

- **`src/core/`:** mtg-manager's logic, ported nearly unchanged. That's the card model, collections, decks, rules,
  search, stats, upgrades, commander ranking, export and EDHREC scoring. It runs in Node and workerd alike, with
  no Node built-ins. The deck schema is compiled ahead of time, into `deck-validator.generated.mjs`, because
  Workers can't compile it at runtime. Run `mise run generate:validator` after editing
  `schemas/deck.schema.json`; a test fails if you forget.
- **`src/storage/cards.mjs`:** loads just the cards a request needs from D1 and rebuilds mtg-manager's in-memory
  cache from them, so `src/core` runs unchanged. A test checks every rebuilt card against `toCard`.
- **`src/storage/collections.mjs`, `decks.mjs`:** each person's collections and decks. They're read into the
  collections model mtg-manager built from files, and every query filters on the signed-in user. Collection
  paths keep the `collections/` prefix without the owner's folder (`collections/binders/Alphabetized.txt`),
  so a deck's `collection_source` patterns match as they did. `src/core/glob.mjs` is a pure-JavaScript port
  of the Node glob matching mtg-manager used, and a test compares the two.
- **`tests/core/`:** mtg-manager's own tests for the ported modules, now run with Vitest.

## Migrating from mtg-manager

`scripts/migrate-from-mtg-manager.mjs` loads each owner folder's collections and decks for one person:

```sh
node scripts/migrate-from-mtg-manager.mjs --source ../mtg-manager \
  --owner conrad=daniel.m.conrad@gmail.com --owner brad=bradleysklenar@gmail.com --remote   # plan only
# ... --apply to write it
```

The script works like this:

- **The plan:** without `--apply`, it lists each person's account, their collections (rows, copies,
  protected or available, and any unmatched text rows) and their decks.
- **What `--apply` does:** it replaces those people's collections and decks, then reads everything back
  through the server's loaders to verify it.
- **Protected collections:** anything under a folder named `precons`, `decks` or `protected`.
- **Text lists:** rows are matched to printings in the target's card data, so run it after the ingest.
- **Reserved accounts:** a person who has never signed in gets one, which their first sign-in claims and pins to
  their Google account.

## Card data

Every card on Scryfall lives in D1:

- **`cards`:** rules text, color identity as a bitmask, legality, and EDHREC rank, with one row per card.
- **`printings`:** set, collector number, rarity and whether it's the default printing, with one row per printing.
- **`commander_pool`:** for each Commander-legal card, what it adds to commander ranking: its themes and creature
  types.
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
