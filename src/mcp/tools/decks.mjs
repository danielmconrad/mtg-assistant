// The read-only deck tools: mtg-manager's deck:show, deck:stats, deck:check, deck:export, deck:verify,
// deck:candidates and deck:upgrades, and a list.
import { z } from 'zod';
import { ROLE_VOCABULARY, applyUpgrades, deckEntries, splitUpgrades } from '../../core/deck.mjs';
import { EXPORT_FORMAT_NAMES, PASTE_HINTS, exportDeck, printingChooser } from '../../core/export.mjs';
import { candidateLines, checkLines, showLines, statsLines, upgradeLines } from '../../core/format.mjs';
import { checkDeck } from '../../core/rules.mjs';
import { ROLE_CHOICES, SORT_CHOICES, deckCandidates } from '../../core/search.mjs';
import { deckListing, deckStats } from '../../core/stats.mjs';
import { upgradeReport } from '../../core/upgrades.mjs';
import { verifyDeck } from '../../core/verify.mjs';
import { loadCollections } from '../../storage/collections.mjs';
import { listDecks, loadDeck } from '../../storage/decks.mjs';
import { ToolError, checkPattern, personalIndex, staleDataWarning, textResult } from './shared.mjs';

export const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(100)
  .describe('The deck’s slug, from list_decks');
const upgrades = z
  .enum(['apply', 'split'])
  .optional()
  .describe('apply: every upgrade swap made; split: cuts and adds in their own sections');

// Every name a deck mentions, so its cards are in the index.
export const namesIn = (deck) => [
  ...deckEntries(deck).map((entry) => entry.name),
  ...(deck.upgrades ?? []).flatMap(({ add, cut }) => [add.name, cut.name]),
  ...(deck.considered ?? []).map(({ name }) => name),
];

async function deckContext(db, userId, deckSlug, { withCollections = false } = {}) {
  const deck = await loadDeck(db, userId, deckSlug);
  if (!deck) throw new ToolError(`No deck named ${deckSlug}; list_decks shows yours`);
  const [{ index, meta }, collections] = await Promise.all([
    personalIndex(db, userId, { names: namesIn(deck) }),
    withCollections
      ? loadCollections(db, userId, { only: deck.collection_source ?? [], own: deck.collection_destination })
      : null,
  ]);
  return { deck, index, meta, collections };
}

function withUpgrades(deck, mode) {
  if (mode === 'apply') return applyUpgrades(deck);
  if (mode === 'split') return splitUpgrades(deck);
  return deck;
}

async function listDecksTool(_args, { db, user }) {
  const decks = await listDecks(db, user.id);
  if (!decks.length) return textResult(['No decks yet.']);
  return textResult(decks.map((deck) => `${deck.slug}: ${deck.name} (${deck.format}, ${deck.status})`));
}

async function showDeck(args, { db, user, now }) {
  const { deck, index, meta } = await deckContext(db, user.id, args.slug);
  const listing = deckListing(withUpgrades(deck, args.upgrades), index, { role: args.role });
  return textResult(showLines(listing, { withOracleText: args.oracle }), [staleDataWarning(meta, now)].filter(Boolean));
}

async function deckStatsTool(args, { db, user, now }) {
  const { deck, index, meta } = await deckContext(db, user.id, args.slug);
  const upgraded = args.upgrades_applied && applyUpgrades(deck);
  const measured = upgraded ? { ...upgraded, mainboard: [...upgraded.mainboard, ...upgraded.upgradesIn] } : deck;
  const stats = deckStats(measured, index);
  return textResult(
    statsLines(deck, stats, { upgradesApplied: Boolean(upgraded) }),
    [staleDataWarning(meta, now)].filter(Boolean),
  );
}

async function checkDeckTool(args, { db, user, now }) {
  const { deck, index, meta, collections } = await deckContext(db, user.id, args.slug, { withCollections: true });
  const report = checkDeck(deck, collections, index, { now });
  return textResult(checkLines(args.slug, report), [staleDataWarning(meta, now)].filter(Boolean));
}

async function exportDeckTool(args, { db, user }) {
  const { deck, index, collections } = await deckContext(db, user.id, args.slug, { withCollections: true });
  const uncached = new Set();
  const printingOf = printingChooser(index, collections.available, uncached);
  const text = exportDeck(withUpgrades(deck, args.upgrades), { format: args.format, printingOf });
  const warnings = ['Exporting does not validate the deck; use check_deck for that.'];
  if (args.upgrades === 'apply' && deck.upgrades?.length) {
    warnings.push(`Applied ${deck.upgrades.length} upgrade swaps; some added cards may not be owned yet.`);
  }
  if (uncached.size) warnings.push(`No printing found, exported by name only: ${[...uncached].join(', ')}`);
  return textResult([text.trimEnd(), '', PASTE_HINTS[args.format]], warnings);
}

// How many left-out cards verify_deck requires a considered reason for, as deck:verify did.
const CANDIDATE_LIMIT = 20;

// The server has no decklist files, and every update_deck records lowest_legal_bracket, so deck:verify's
// advice to run deck:files becomes saving the deck.
const serverAdvice = (line) => line.replace('; run deck:files', '; any update_deck call records it');

async function verifyDeckTool(args, { db, user, now }) {
  const { deck, index, meta, collections } = await deckContext(db, user.id, args.slug, { withCollections: true });
  const none = new Map();
  const report = verifyDeck({
    deck,
    collections,
    index,
    limit: args.limit,
    decklists: { expected: none, actual: none },
    now,
  });
  return textResult(checkLines(args.slug, report).map(serverAdvice), [staleDataWarning(meta, now)].filter(Boolean));
}

async function deckCandidatesTool(args, { db, user, now }) {
  for (const value of args.text ?? []) checkPattern(value, 'text');
  for (const value of args.type ?? []) checkPattern(value, 'type');
  const { deck, index, meta, collections } = await deckContext(db, user.id, args.slug, { withCollections: true });
  let candidates;
  try {
    candidates = deckCandidates(deck, collections, index, {
      texts: (args.text ?? []).map((source) => new RegExp(source, 'i')),
      types: (args.type ?? []).map((source) => new RegExp(source, 'i')),
      roles: args.role ?? [],
      lands: args.lands,
      sort: args.sort,
    });
  } catch (error) {
    throw new ToolError(error.message);
  }
  const { results, unresolvedRows, overCap } = candidates;
  const lines = candidateLines(results, { limit: args.limit, withOracleText: args.oracle, unresolvedRows, overCap });
  return textResult(lines, [staleDataWarning(meta, now)].filter(Boolean));
}

async function deckUpgradesTool(args, { db, user, now }) {
  const { deck, index, meta, collections } = await deckContext(db, user.id, args.slug, { withCollections: true });
  let report;
  try {
    report = upgradeReport(deck, collections, index, { now });
  } catch (error) {
    throw new ToolError(error.message);
  }
  return textResult(upgradeLines(report), [staleDataWarning(meta, now)].filter(Boolean));
}

const pattern = z.string().min(1).max(200);

export const DECK_TOOLS = [
  {
    name: 'list_decks',
    title: 'List decks',
    description: "The person's decks: slug, name, format and status (draft, built, archived...).",
    schema: z.object({}).strict(),
    handler: listDecksTool,
  },
  {
    name: 'show_deck',
    title: 'Show a deck',
    description:
      "A deck's commanders and mainboard grouped by role, optionally one role and with rules text, so a review reads the real list rather than recalling it.",
    schema: z
      .object({
        slug,
        role: z.enum(ROLE_VOCABULARY).optional(),
        oracle: z.boolean().optional().describe('Include each card’s rules text'),
        upgrades,
      })
      .strict(),
    handler: showDeck,
  },
  {
    name: 'deck_stats',
    title: 'Deck stats',
    description:
      "A deck's mana curve, card types, color pips and sources, role counts against targets, and opening-hand odds.",
    schema: z
      .object({ slug, upgrades_applied: z.boolean().optional().describe('Measure the deck with every upgrade made') })
      .strict(),
    handler: deckStatsTool,
  },
  {
    name: 'check_deck',
    title: 'Check a deck',
    description:
      'Check a deck against its format’s rules (size, commanders, color identity, bans, copy limits, bracket) and against the person’s collection (ownership), listing every error and note.',
    schema: z.object({ slug }).strict(),
    handler: checkDeckTool,
  },
  {
    name: 'export_deck',
    title: 'Export a decklist',
    description:
      'A paste-ready decklist for Moxfield, Archidekt or plain text, choosing the printings the person owns.',
    schema: z.object({ slug, format: z.enum(EXPORT_FORMAT_NAMES).default('moxfield'), upgrades }).strict(),
    handler: exportDeckTool,
  },
  {
    name: 'verify_deck',
    title: 'Verify a deck',
    description:
      'Whether a deck is ready to hand off: check_deck’s findings plus a real primer, complete stats, land count and role targets against the frameworks, a considered reason for each of the top left-out cards, upgrades within budget, and a judged plays_like_bracket.',
    schema: z
      .object({
        slug,
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(CANDIDATE_LIMIT)
          .describe('How many top left-out cards need a reason'),
      })
      .strict(),
    handler: verifyDeckTool,
  },
  {
    name: 'deck_candidates',
    title: 'Left-out cards',
    description:
      'The available cards a deck could play and leaves out, by EDHREC rank (or price), each with its considered reason if it has one, so a review covers every strong card. Filter by role, rules text or type; lands only with lands.',
    schema: z
      .object({
        slug,
        role: z.array(z.enum(ROLE_CHOICES)).max(5).optional(),
        text: z.array(pattern).max(5).optional().describe('Case-insensitive regexes on the rules text; all must match'),
        type: z.array(pattern).max(5).optional().describe('Case-insensitive regexes on the type line; all must match'),
        lands: z.boolean().optional().describe('Include lands, which are left out otherwise'),
        sort: z.enum(SORT_CHOICES).default('edhrec'),
        oracle: z.boolean().optional().describe('Include each card’s rules text'),
        limit: z.number().int().min(1).max(200).default(CANDIDATE_LIMIT),
      })
      .strict(),
    handler: deckCandidatesTool,
  },
  {
    name: 'deck_upgrades',
    title: 'Price upgrades',
    description:
      'Prices what a deck still needs to buy (its upgrade adds and any cards the collection can’t supply) at the cheapest recent price, against its budget. Unknown prices are reported, never counted as zero.',
    schema: z.object({ slug }).strict(),
    handler: deckUpgradesTool,
  },
];
