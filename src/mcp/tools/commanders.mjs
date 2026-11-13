// rank_commanders: mtg-manager's collection:commanders. Every Commander-legal commander, owned or not,
// ranked by how much of the person's collection feeds the themes its rules text cares about. The pool
// it compares against is precomputed by the ingest (commander_pool), so only the candidates and the
// person's own cards load in full.
import { z } from 'zod';
import { COMMANDER_SORT_CHOICES, DEFAULT_MIN_CARDS, commanderFilters, rankCommanders } from '../../core/commanders.mjs';
import { isActiveDeck } from '../../core/deck.mjs';
import { commanderLines } from '../../core/format.mjs';
import { loadCommanderPool, loadCommanderRows } from '../../storage/cards.mjs';
import { loadCollections } from '../../storage/collections.mjs';
import { loadAllDecks } from '../../storage/decks.mjs';
import { identityMask } from '../../storage/search-sql.mjs';
import { ToolError, checkPattern, personalIndex, staleDataWarning, textResult } from './shared.mjs';

const DEFAULT_LIMIT = 25;

const schema = z
  .object({
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
      .describe('lift: owned on-theme cards against an average collection; cards: the most on-theme cards'),
    limit: z.number().int().min(1).max(100).default(DEFAULT_LIMIT),
    oracle: z.boolean().optional().describe('Include each commander’s rules text'),
  })
  .strict();

async function rankCommandersTool(args, { db, user, now }) {
  if (args.name) checkPattern(args.name, 'name');
  if (args.theme) checkPattern(args.theme, 'theme');
  const mask = args.identity ? identityMask(args.identity) : undefined;
  const [collections, pool, commanderRows, decks] = await Promise.all([
    loadCollections(db, user.id),
    loadCommanderPool(db),
    loadCommanderRows(db, { identityMask: mask }),
    loadAllDecks(db, user.id),
  ]);
  const activeDecks = decks.filter(({ deck }) => isActiveDeck(deck));
  const { index, meta } = await personalIndex(db, user.id, {
    names: activeDecks.flatMap(({ deck }) => deck.commanders.map((entry) => entry.name)),
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
  const ranking = rankCommanders(collections, index, filters, { decks: activeDecks, pool: { ...pool, commanderIds } });
  const warnings = [staleDataWarning(meta, now)].filter(Boolean);
  if (!pool.cards.length) warnings.push('The commander pool is empty until the nightly Scryfall ingest runs');
  if (args.sort === 'edhrec') warnings.push('No EDHREC pages are loaded yet, so edhrec sorting falls back to lift');
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

export const COMMANDER_TOOLS = [
  {
    name: 'rank_commanders',
    title: 'Rank commanders',
    description:
      "Rank every Commander-legal commander, owned or not, by how much of the person's collection feeds the themes and creature types its rules text cares about, compared with an average collection of the same size. Filter by identity, ownership, name, theme and price. Use it to find commanders to build around or buy; the scores are rough, so read the cards before trusting a rank.",
    schema,
    handler: rankCommandersTool,
  },
];
