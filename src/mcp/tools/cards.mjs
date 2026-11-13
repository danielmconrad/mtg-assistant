// search_cards and get_cards: mtg-manager's collection:search and card:show.
import { z } from 'zod';
import { cardReports } from '../../core/card-report.mjs';
import { isActiveDeck } from '../../core/deck.mjs';
import { cardReportLines, countLine, groupLines, searchLines } from '../../core/format.mjs';
import {
  GROUP_BY_CHOICES,
  RARITY_CHOICES,
  ROLE_CHOICES,
  SORT_CHOICES,
  countResults,
  groupResults,
  searchCollection,
  searchFilters,
  sortResults,
} from '../../core/search.mjs';
import { loadMatchingRows, nameSuggester, printingCounts } from '../../storage/cards.mjs';
import { loadCollections } from '../../storage/collections.mjs';
import { loadAllDecks } from '../../storage/decks.mjs';
import { searchPrefilter } from '../../storage/search-sql.mjs';
import { ToolError, checkPattern, personalIndex, staleDataWarning, textResult } from './shared.mjs';

// A search of unowned or all cards loads its candidates into memory, so very broad ones are refused.
export const MAX_CANDIDATES = 4000;
const DEFAULT_LIMIT = 50;
const FORMATS = [
  'commander',
  'brawl',
  'standardbrawl',
  'standard',
  'pioneer',
  'modern',
  'legacy',
  'vintage',
  'pauper',
  'paupercommander',
  'oathbreaker',
  'historic',
  'timeless',
  'alchemy',
  'explorer',
  'predh',
  'premodern',
  'oldschool',
  'penny',
  'duel',
  'future',
  'gladiator',
];

const pattern = z.string().min(1).max(200);
const searchSchema = z
  .object({
    scope: z
      .enum(['owned', 'unowned', 'all'])
      .default('owned')
      .describe('owned: available copies (default); unowned: cards with no available copy; all: every card'),
    commander: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("A commander's name: limits to its color identity and Commander legality"),
    identity: z
      .string()
      .regex(/^[WUBRGCwubrgc]+$/)
      .max(6)
      .optional()
      .describe('Color identity letters, e.g. BG; C for colorless. Includes every subset'),
    name: pattern.optional().describe('Case-insensitive regex on the name'),
    type: z.array(pattern).max(5).optional().describe('Case-insensitive regexes on the type line; all must match'),
    text: z.array(pattern).max(5).optional().describe('Case-insensitive regexes on the rules text; all must match'),
    role: z.array(z.enum(ROLE_CHOICES)).max(5).optional().describe('Rough rules-text tests for deck roles'),
    min_mv: z.number().min(0).max(20).optional(),
    max_mv: z.number().min(0).max(20).optional(),
    legal: z.enum(FORMATS).optional().describe('Legal in this Scryfall format'),
    commanders_only: z.boolean().optional().describe('Only cards that can be a commander'),
    nonland: z.boolean().optional(),
    game_changers: z.boolean().optional(),
    include_protected: z.boolean().optional().describe('Also list cards held only in protected collections'),
    proxies: z.boolean().optional().describe('Count proxy copies as owned'),
    set: z.array(z.string().min(1).max(40)).max(10).optional().describe('Scryfall set codes, e.g. trk'),
    rarity: z.array(z.enum(RARITY_CHOICES)).max(6).optional(),
    max_price: z.number().min(0).max(100000).optional().describe('Cheapest playable printing at most this many USD'),
    min_copies: z.number().int().min(1).max(1000).optional(),
    sort: z
      .enum(SORT_CHOICES)
      .optional()
      .describe('mv (default), edhrec (most played first) or price (most valuable first)'),
    group_by: z.enum(GROUP_BY_CHOICES).optional().describe('Count cards per group instead of listing them'),
    count: z.boolean().optional().describe('Just count the matching cards and copies'),
    oracle: z.boolean().optional().describe('Include each card’s rules text'),
    limit: z.number().int().min(1).max(200).default(DEFAULT_LIMIT),
  })
  .strict();

// The tool's arguments as mtg-manager's collection:search options.
function asOptions(args) {
  const number = (value) => (value === undefined ? undefined : String(value));
  return {
    commander: args.commander,
    identity: args.identity,
    name: args.name,
    type: args.type,
    text: args.text,
    role: args.role,
    legal: args.legal,
    'min-mv': number(args.min_mv),
    'max-mv': number(args.max_mv),
    commanders: args.commanders_only,
    nonland: args.nonland,
    'game-changers': args.game_changers,
    'include-protected': args.include_protected,
    proxies: args.proxies,
    unowned: args.scope === 'unowned',
    'all-cards': args.scope === 'all',
    set: args.set,
    rarity: args.rarity,
    'max-price': number(args.max_price),
    'min-copies': number(args.min_copies),
  };
}

// Set codes as search.mjs reads them: repeated or comma-separated, in Scryfall's lower case.
const setCodes = (values = []) =>
  values
    .flatMap((value) => value.split(','))
    .map((code) => code.trim().toLowerCase())
    .filter(Boolean);

async function commanderMask(db, name) {
  const key = name.trim().toLocaleLowerCase('en-US');
  const { results } = await db
    .prepare('SELECT DISTINCT color_identity FROM cards WHERE playable = 1 AND (name_key = ? OR front_name_key = ?)')
    .bind(key, key)
    .all();
  return results.length === 1 ? results[0].color_identity : undefined;
}

// Candidates beyond the person's own cards, narrowed in SQL first.
async function candidateRows(db, args) {
  const mask = args.commander ? await commanderMask(db, args.commander) : undefined;
  const filter = searchPrefilter(args, { identityMask: mask });
  const { n } = await db
    .prepare(`SELECT COUNT(*) AS n FROM cards c WHERE ${filter.sql}`)
    .bind(...filter.params)
    .first();
  if (n > MAX_CANDIDATES) {
    throw new ToolError(
      `That ${args.scope} search matches ${n} cards before the regex filters, over ${MAX_CANDIDATES}; narrow it with identity, type, text, set, legal or mana value`,
    );
  }
  return loadMatchingRows(db, filter);
}

function checkSearchArgs(args) {
  const patterns = [
    ['name', args.name === undefined ? [] : [args.name]],
    ['type', args.type ?? []],
    ['text', args.text ?? []],
  ];
  for (const [field, values] of patterns) for (const value of values) checkPattern(value, field);
  if (args.count && args.group_by) throw new ToolError('Use count or group_by, not both');
}

// The search's text: groups, a count, or the cards (up to limit), as collection:search printed them.
function searchOutput(sorted, args, availableNames) {
  if (args.group_by) return groupLines(groupResults(sorted, args.group_by));
  if (args.count) return [countLine(countResults(sorted), availableNames)];
  const shown = sorted.slice(0, args.limit);
  const lines = searchLines(shown, {
    withOracleText: args.oracle,
    withValues: args.sort === 'edhrec' || args.sort === 'price',
    withPrinting: Boolean(args.set || args.rarity),
  });
  if (sorted.length > shown.length) {
    lines[lines.length - 1] =
      `${shown.length} of ${sorted.length} cards shown; narrow the search, or raise limit (max 200)`;
  }
  return lines;
}

function filtersFor(args, index) {
  try {
    return searchFilters(asOptions(args), index);
  } catch (error) {
    throw new ToolError(error.message);
  }
}

async function searchCards(args, { db, user, now }) {
  checkSearchArgs(args);
  const extraRows = args.scope === 'owned' ? [] : await candidateRows(db, args);
  const [collections, { index, meta }] = await Promise.all([
    loadCollections(db, user.id),
    personalIndex(db, user.id, {
      names: args.commander ? [args.commander] : [],
      extraRows,
      sets: setCodes(args.set),
      rarities: args.rarity ?? [],
    }),
  ]);
  const { results, unresolvedRows } = searchCollection(collections, index, filtersFor(args, index));
  const warnings = [staleDataWarning(meta, now)].filter(Boolean);
  if (unresolvedRows) warnings.push(`${unresolvedRows} collection rows have no card data and were skipped`);
  return textResult(searchOutput(sortResults(results, args.sort), args, collections.availableNames), warnings);
}

const getCardsSchema = z
  .object({
    names: z
      .array(z.string().min(1).max(200))
      .min(1)
      .max(20)
      .describe('Exact card names; misspellings get suggestions'),
  })
  .strict();

async function getCards({ names }, { db, user, now }) {
  const [collections, { index, meta }, decks] = await Promise.all([
    loadCollections(db, user.id),
    personalIndex(db, user.id, { names }),
    loadAllDecks(db, user.id),
  ]);
  const reports = cardReports(names, { index, collections, decks: decks.filter(({ deck }) => isActiveDeck(deck)) });
  // The index holds only the printings a request reads; report how many Scryfall has.
  const counts = await printingCounts(
    db,
    reports.filter((report) => report.card).map((report) => report.card.oracleId),
  );
  for (const report of reports.filter((candidate) => candidate.card)) {
    report.printings = counts.get(report.card.oracleId) ?? report.printings;
  }
  // The index holds only the person's and the named cards, so suggestions come from every card's name.
  if (reports.some((report) => report.problem)) {
    const suggest = await nameSuggester(db);
    for (const report of reports.filter((candidate) => /not in card cache/.test(candidate.problem))) {
      report.suggestions = suggest(report.name);
      report.problem = report.suggestions.length
        ? `${report.name}: no card by that name; did you mean ${report.suggestions.join(', ')}?`
        : `${report.name}: no card by that name; check the spelling`;
    }
  }
  return textResult(cardReportLines(reports), [staleDataWarning(meta, now)].filter(Boolean));
}

export const CARD_TOOLS = [
  {
    name: 'search_cards',
    title: 'Search cards',
    description:
      "Search the person's collection (scope owned, the default), cards they don't own (unowned), or every Magic card (all), by color identity or commander, type, rules text, mana value, role, legality, set, rarity, price and copies. Size up first with count or group_by, then list. Results come from the card database, never memory.",
    schema: searchSchema,
    handler: searchCards,
  },
  {
    name: 'get_cards',
    title: 'Look up cards',
    description:
      'Look up cards by exact name, owned or not: rules text, Commander legality, Game Changer status, EDHREC rank, cheapest price, available and protected copies, and every deck that plays, cuts, adds or considered the card.',
    schema: getCardsSchema,
    handler: getCards,
  },
];
