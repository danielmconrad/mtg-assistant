// rank_commanders and refresh_edhrec: mtg-manager's collection:commanders and edhrec:refresh. Every
// Commander-legal commander, owned or not, ranked by how much of the person's collection feeds the themes
// its rules text cares about. The pool it compares against is precomputed by the ingest (commander_pool),
// so only the candidates and the person's own cards load in full. Commanders with a cached EDHREC page
// also show how much of it the person owns.
import { z } from 'zod';
import { COMMANDER_SORT_CHOICES, DEFAULT_MIN_CARDS, commanderFilters, rankCommanders } from '../../core/commanders.mjs';
import { DEFAULT_MAX_AGE_DAYS, fetchPages, isStale } from '../../core/edhrec.mjs';
import { isActiveDeck } from '../../core/deck.mjs';
import { commanderLines } from '../../core/format.mjs';
import { OutboundRefused, boundedJson, outboundFetch } from '../../outbound.mjs';
import {
  cardIndexFor,
  loadCardRows,
  loadCommanderPool,
  loadCommanderRows,
  nameSuggester,
} from '../../storage/cards.mjs';
import { loadCollections } from '../../storage/collections.mjs';
import { loadAllDecks } from '../../storage/decks.mjs';
import { loadEdhrecFetchedAt, loadEdhrecPages, saveEdhrecPage } from '../../storage/edhrec.mjs';
import { identityMask } from '../../storage/search-sql.mjs';
import { ToolError, checkPattern, personalIndex, staleDataWarning, textResult } from './shared.mjs';

const DEFAULT_LIMIT = 25;
// Pages one refresh_edhrec call fetches at most, a second apart; RL_EDHREC also spaces them across calls.
const MAX_REFRESH = 10;

const filterFields = {
  identity: z
    .string()
    .regex(/^[WUBRGCwubrgc]+$/)
    .max(6)
    .optional()
    .describe('Only commanders whose color identity fits within these colors; C means colorless only'),
  ownership: z
    .enum(['owned', 'unowned'])
    .optional()
    .describe('Only commanders the person owns, or only ones they could buy'),
  name: z.string().min(1).max(200).optional().describe('Case-insensitive regex on the commander’s name'),
  theme: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Only commanders with a theme or creature type matching this regex, e.g. food or Dwarf'),
  max_price: z
    .number()
    .min(0)
    .max(100000)
    .optional()
    .describe('Commander’s cheapest playable printing at most this many USD'),
};

const schema = z
  .object({
    ...filterFields,
    min_cards: z
      .number()
      .int()
      .min(0)
      .max(100)
      .default(DEFAULT_MIN_CARDS)
      .describe('Fewest owned on-theme cards to be listed (0 lists all)'),
    sort: z
      .enum(COMMANDER_SORT_CHOICES)
      .default('lift')
      .describe(
        'lift: owned on-theme cards against an average collection; cards: the most on-theme cards; edhrec: the most of a cached EDHREC page owned (refresh_edhrec)',
      ),
    limit: z.number().int().min(1).max(100).default(DEFAULT_LIMIT),
    oracle: z.boolean().optional().describe('Include each commander’s rules text'),
  })
  .strict();

// The ranking rank_commanders shows, which refresh_edhrec's top also reads.
async function ranked(args, { db, user }) {
  if (args.name) checkPattern(args.name, 'name');
  if (args.theme) checkPattern(args.theme, 'theme');
  const mask = args.identity ? identityMask(args.identity) : undefined;
  const [collections, pool, commanderRows, decks, edhrec] = await Promise.all([
    loadCollections(db, user.id),
    loadCommanderPool(db),
    loadCommanderRows(db, { identityMask: mask }),
    loadAllDecks(db, user.id),
    loadEdhrecPages(db),
  ]);
  const activeDecks = decks.filter(({ deck }) => isActiveDeck(deck));
  const { index, meta } = await personalIndex(db, user.id, {
    // A page's unowned cards count toward its totals, so they're indexed too.
    names: [
      ...activeDecks.flatMap(({ deck }) => deck.commanders.map((entry) => entry.name)),
      ...Object.values(edhrec).flatMap((page) => (page.cards ?? []).map((listing) => listing.name)),
    ],
    extraRows: commanderRows,
  });
  let filters;
  try {
    filters = commanderFilters({
      identity: args.identity,
      [args.ownership]: Boolean(args.ownership),
      name: args.name,
      theme: args.theme,
      'max-price': args.max_price,
      'min-cards': args.min_cards,
      sort: args.sort,
    });
  } catch (error) {
    throw new ToolError(error.message);
  }
  const commanderIds = [...new Set(commanderRows.map((row) => row.oracle_id))];
  const ranking = rankCommanders(collections, index, filters, {
    decks: activeDecks,
    pool: { ...pool, commanderIds },
    edhrec,
  });
  return { ranking, filters, meta, pool, edhrec };
}

async function rankCommandersTool(args, context) {
  const { ranking, filters, meta, pool, edhrec } = await ranked(args, context);
  const warnings = [staleDataWarning(meta, context.now)].filter(Boolean);
  if (!pool.cards.length) warnings.push('The commander pool is empty until the nightly Scryfall ingest runs');
  if (args.sort === 'edhrec' && !Object.keys(edhrec).length) {
    warnings.push('No EDHREC pages are cached yet, so edhrec sorting falls back to lift; refresh_edhrec fetches them');
  }
  if (ranking.unresolvedRows) {
    warnings.push(`${ranking.unresolvedRows} collection rows have no card data and were skipped`);
  }
  const lines = commanderLines(ranking.results, {
    limit: args.limit,
    withOracleText: args.oracle,
    sort: filters.sort,
    minCards: filters.minCards,
    belowMinimum: ranking.belowMinimum,
    unthemed: ranking.unthemed,
    considered: ranking.considered,
    themeFiltered: Boolean(filters.theme),
  });
  return textResult(lines, warnings);
}

// Commander names as the card data spells them; unknown ones are refused with suggestions.
async function canonicalCommanders(db, names) {
  const { index } = await cardIndexFor(db, await loadCardRows(db, { names }));
  const problems = [];
  const found = [];
  for (const name of names) {
    const { card } = index.lookup({ name });
    if (card) found.push(card.name);
    else problems.push(name);
  }
  if (problems.length) {
    const suggest = await nameSuggester(db);
    throw new ToolError(
      problems
        .map((name) => {
          const suggestions = suggest(name);
          return `No card named ${name}${suggestions.length ? `; did you mean ${suggestions.join(', ')}?` : ''}`;
        })
        .join('\n'),
    );
  }
  return found;
}

// Fetches one page through the outbound allowlist, if the shared limiter allows another request now.
function pageFetcher(env) {
  return async (url, init) => {
    const { success } = await env.RL_EDHREC.limit({ key: 'edhrec' });
    if (!success) throw new ToolError('EDHREC was asked for many pages just now; try again in a minute');
    const response = await outboundFetch(url, init);
    // core/edhrec.mjs reads response.json(); bound it first.
    return { status: response.status, ok: response.ok, headers: response.headers, json: () => boundedJson(response) };
  };
}

async function refreshEdhrec(args, context) {
  const { db, env, now } = context;
  if (!args.commanders?.length && !args.top) {
    throw new ToolError('Name commanders, or pass top to refresh the best-ranked ones');
  }
  const named = await canonicalCommanders(db, args.commanders ?? []);
  const top = args.top
    ? (await ranked({ ...args, min_cards: DEFAULT_MIN_CARDS }, context)).ranking.results.slice(0, args.top)
    : [];
  const names = [...new Set([...named, ...top.map(({ card }) => card.name)])].slice(0, MAX_REFRESH);
  const fetchedAt = await loadEdhrecFetchedAt(db, names);
  const wanted = names.filter(
    (name) => args.force || isStale(fetchedAt.has(name) && { fetchedAt: fetchedAt.get(name) }, now, args.max_age_days),
  );
  const fetched = [];
  let stopped;
  try {
    await fetchPages(wanted, {
      fetchFn: pageFetcher(env),
      now,
      onPage: (name, page) => fetched.push(saveEdhrecPage(db, name, page).then(() => ({ name, page }))),
    });
  } catch (error) {
    if (!(error instanceof ToolError || error instanceof OutboundRefused || /EDHREC/.test(error.message))) throw error;
    stopped = error.message;
  }
  const saved = await Promise.all(fetched);
  const lines = [
    ...saved.map(
      ({ name, page }) => `Fetched ${name}${page.missing ? ' (EDHREC has no page)' : ` (${page.decks} decks)`}`,
    ),
    `EDHREC pages for ${names.length} commanders: ${saved.length} fetched, ${names.length - wanted.length} already fresh (within ${args.max_age_days} days).`,
    ...(saved.length ? ['rank_commanders now shows how much of each page the person owns.'] : []),
  ];
  return textResult(lines, stopped ? [`Stopped early: ${stopped}`] : []);
}

export const COMMANDER_TOOLS = [
  {
    name: 'rank_commanders',
    title: 'Rank commanders',
    description:
      "Rank every Commander-legal commander, owned or not, by how much of the person's collection feeds the themes and creature types its rules text cares about, compared with an average collection of the same size. Filter by identity, ownership, name, theme and price. Use it to find commanders to build around or buy; the scores are rough, so read the cards before trusting a rank.",
    schema,
    handler: rankCommandersTool,
  },
  {
    name: 'refresh_edhrec',
    title: 'Refresh EDHREC pages',
    description: `Fetch EDHREC's commander pages (which cards decks with each commander play), for commanders named or the top of rank_commanders under the same filters, at most ${MAX_REFRESH} a call, one a second. Pages are shared and kept for max_age_days. Afterwards rank_commanders shows how much of each page the person owns, and sort edhrec ranks by it.`,
    schema: z
      .object({
        commanders: z.array(z.string().min(1).max(200)).max(MAX_REFRESH).optional().describe('Commanders by name'),
        top: z
          .number()
          .int()
          .min(1)
          .max(MAX_REFRESH)
          .optional()
          .describe('The N commanders rank_commanders lists first'),
        ...filterFields,
        max_age_days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .default(DEFAULT_MAX_AGE_DAYS)
          .describe('Keep pages fetched within this many days'),
        force: z.boolean().default(false).describe('Fetch again, however recent'),
      })
      .strict(),
    annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true, destructiveHint: false },
    handler: refreshEdhrec,
  },
];
