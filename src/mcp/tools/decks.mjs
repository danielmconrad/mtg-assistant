// The read-only deck tools: mtg-manager's deck:show, deck:stats, deck:check and deck:export, and a list.
import { z } from 'zod';
import { ROLE_VOCABULARY, applyUpgrades, deckEntries, splitUpgrades } from '../../core/deck.mjs';
import { EXPORT_FORMAT_NAMES, PASTE_HINTS, exportDeck, printingChooser } from '../../core/export.mjs';
import { checkLines, showLines, statsLines } from '../../core/format.mjs';
import { checkDeck } from '../../core/rules.mjs';
import { deckListing, deckStats } from '../../core/stats.mjs';
import { loadCollections } from '../../storage/collections.mjs';
import { listDecks, loadDeck } from '../../storage/decks.mjs';
import { ToolError, personalIndex, staleDataWarning, textResult } from './shared.mjs';

const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(100)
  .describe('The deck’s slug, from list_decks');
const upgrades = z
  .enum(['apply', 'split'])
  .optional()
  .describe('apply: every upgrade swap made; split: cuts and adds in their own sections');

// Every name a deck mentions, so its cards are in the index.
const namesIn = (deck) => [
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
      'Check a deck against its format’s rules (size, commanders, color identity, bans, copy limits, bracket) and against the person’s collections (ownership), listing every error and note.',
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
];
