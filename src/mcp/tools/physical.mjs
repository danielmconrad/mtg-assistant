// build_deck, teardown_deck and swap_deck: mtg-manager's physical-deck commands, moving a deck's cards
// between the person's collections when they say they've sleeved, unsleeved or swapped the real cards.
// Each shows its plan unless apply is true. An applied move changes every collection it touches and the
// deck in one batch, which applies only if none of them changed since the plan was made.
import { z } from 'zod';
import { planBuild, planSwapOut, printingLine, nameLine } from '../../core/build.mjs';
import { isLand } from '../../core/card.mjs';
import { serializeDeck, validateDeck, withMainboardSwaps, resolveEntries } from '../../core/deck.mjs';
import { checkLines } from '../../core/format.mjs';
import { baselineOutcome, checkDeck } from '../../core/rules.mjs';
import {
  applyCollectionChanges,
  entriesFor,
  isValidCollectionName,
  newTextCollection,
  planChange,
} from '../../storage/collection-writes.mjs';
import { isProtectedPath, listCollections, loadCollections } from '../../storage/collections.mjs';
import { loadAllDecks, loadDeckForUpdate } from '../../storage/decks.mjs';
import { recordBrackets } from './deck-writes.mjs';
import { namesIn, slug } from './decks.mjs';
import { ToolError, personalIndex, textResult } from './shared.mjs';

const collectionName = z.string().min(1).max(120);
const apply = z.boolean().default(false).describe('Make the move; without it, only show the plan');
const WRITES = { readOnlyHint: false, openWorldHint: false, idempotentHint: false, destructiveHint: true };
const today = (now) => new Date(now).toISOString().slice(0, 10);

async function loadDeck(db, userId, deckSlug) {
  const loaded = await loadDeckForUpdate(db, userId, deckSlug);
  if (!loaded) throw new ToolError(`No deck named ${deckSlug}; list_decks shows yours`);
  return loaded;
}

// What a move does to each collection it touches: { collection, takes: [{ row, card, quantity }],
// copies: [{ card, finish, quantity, tracked }], remove }, keyed by collection name. Rows are the
// collections model's rows; each is matched to its stored entry by position when the move is applied.
function moveSet(known) {
  const moves = new Map();
  const of = (collection) => {
    if (!moves.has(collection.name)) moves.set(collection.name, { collection, takes: [], copies: [], remove: false });
    return moves.get(collection.name);
  };
  return {
    take: (collection, take) => of(collection).takes.push(take),
    put: (collection, copy) => of(collection).copies.push(copy),
    remove: (collection) => {
      of(collection).remove = true;
    },
    moves,
    known,
  };
}

// A collection by name: an existing one, or a new text list for a destination. A built deck's own list is
// refused, since it belongs to that deck.
function destination(name, { known, decks, own, now }) {
  const existing = known.find((collection) => collection.name === name);
  if (existing) {
    if (existing.path === own) throw new ToolError(`${name} is this deck's own list`);
    const builtInto = decks.find(({ deck }) => deck.collection_destination === existing.path);
    if (builtInto) throw new ToolError(`${name} holds the built deck ${builtInto.slug}`);
    return existing;
  }
  if (!isValidCollectionName(name)) {
    throw new ToolError(
      `${name} can't be a collection name: use folders and names of letters, digits, spaces, dots, underscores and hyphens`,
    );
  }
  return newTextCollection(name, now);
}

const copyLine = ({ card, finish, quantity, tracked }) =>
  tracked ? printingLine(quantity, card, finish) : nameLine(quantity, card);

function planLines(set, verb) {
  const lines = [];
  for (const { collection, takes, copies, remove } of set.moves.values()) {
    const label = `${collection.name}${collection.isNew ? ' (new)' : ''}`;
    if (takes.length && !remove) {
      const takeLine = ({ row, card, quantity }) =>
        row.set ? printingLine(quantity, card, row.finish) : nameLine(quantity, card);
      lines.push(`${verb.take} from ${label}:`, ...takes.map((take) => `  ${takeLine(take)}`));
    }
    if (copies.length) lines.push(`${verb.put} into ${label}:`, ...copies.map((copy) => `  ${copyLine(copy)}`));
  }
  return lines;
}

// Applies a move set (and the deck) as one batch.
async function applyMoves(db, userId, set, { source, deck, now }) {
  const changes = [];
  for (const { collection, takes, copies, remove } of set.moves.values()) {
    const entries = collection.isNew ? [] : await entriesFor(db, userId, collection.id);
    const byPosition = new Map(entries.map((entry) => [entry.position, entry]));
    const entryTakes = takes.map(({ row, quantity }) => ({ entry: byPosition.get(row.position), quantity }));
    if (entryTakes.some(({ entry }) => !entry)) {
      throw new ToolError(`${collection.name} changed while this was planned; try again`);
    }
    const additions = copies.map(({ card, finish, quantity, tracked }) => ({
      name: card.name,
      scryfallId: card.id,
      ...(tracked ? { set: card.set, collectorNumber: card.collectorNumber } : {}),
      finish,
      quantity,
    }));
    const plan = remove
      ? { updates: new Map(), inserts: [], deletes: entries.map((entry) => entry.id) }
      : planChange(entries, { takes: entryTakes, copies: additions });
    const events = [
      ...(remove
        ? entries.map((entry) => ({
            name: entry.name,
            scryfallId: entry.scryfall_id,
            finish: entry.finish,
            change: -entry.quantity,
          }))
        : []),
      ...entryTakes.map(({ entry, quantity }) => ({
        name: entry.name,
        scryfallId: entry.scryfall_id,
        finish: entry.finish,
        change: -quantity,
      })),
      ...additions.map((copy) => ({
        name: copy.name,
        scryfallId: copy.scryfallId,
        finish: copy.finish,
        change: copy.quantity,
      })),
    ];
    changes.push({ collection, plan, events, remove });
  }
  validateDeck(deck.doc, deck.slug);
  if (!(await applyCollectionChanges(db, userId, changes, { source, now, deck }))) {
    throw new ToolError('A collection or the deck changed while this was being saved; run it again');
  }
}

// The deck's collections and card index, as check_deck reads them, with any further names indexed.
async function deckWorld(db, userId, deck, { names = [], now }) {
  const [collections, { index }, known, decks] = await Promise.all([
    loadCollections(db, userId, { only: deck.collection_source ?? [], own: deck.collection_destination }),
    personalIndex(db, userId, { names: [...namesIn(deck), ...names] }),
    listCollections(db, userId),
    loadAllDecks(db, userId),
  ]);
  return { collections, index, known, decks, now };
}

const notApplied = (lines, what) => textResult([...lines, `Nothing changed; call again with apply: true ${what}.`]);

// Drafts that play a card the build takes, from a collection they read too, so they may come up short.
async function affectedDrafts(db, userId, deckSlug, plan, decks, index) {
  const taken = new Map(
    plan.takes.map(({ card, row }) => [card.oracleId, { name: card.name, collection: row.collection }]),
  );
  const affected = [];
  for (const { slug: other, deck } of decks.filter(
    ({ slug: candidate, deck: draft }) => candidate !== deckSlug && draft.status === 'draft',
  )) {
    const { availableNames } = await loadCollections(db, userId, { only: deck.collection_source ?? [] });
    const cards = [...resolveEntries([...deck.commanders, ...deck.mainboard], index).tallies.values()]
      .map(({ card }) => taken.get(card.oracleId))
      .filter((use) => use && availableNames.includes(use.collection))
      .map(({ name }) => name);
    if (cards.length) affected.push(`  ${other}: ${[...new Set(cards)].join(', ')}`);
  }
  return affected.length
    ? ['Drafts that also play cards this takes, which may come up short afterwards:', ...affected]
    : [];
}

async function buildDeck(args, { db, user, now }) {
  const { deck, updatedAt } = await loadDeck(db, user.id, args.slug);
  if (deck.collection_destination) {
    throw new ToolError(`${args.slug} is already built into ${deck.collection_destination}`);
  }
  const world = await deckWorld(db, user.id, deck, { now });
  const report = checkDeck(deck, world.collections, world.index, { now });
  if (baselineOutcome(report) !== 'pass') {
    return textResult([...checkLines(args.slug, report), `Not built: ${args.slug} must pass check_deck first.`]);
  }
  const plan = planBuild(deck, world.collections, world.index);
  if (plan.problems.length) {
    return textResult([
      ...plan.problems.map((problem) => `ERROR: ${problem}`),
      `Not built: ${args.slug} needs these cards owned as real copies first.`,
    ]);
  }
  const name = args.to ?? `decks/${args.slug}`;
  if (world.known.some((collection) => collection.name === name)) {
    throw new ToolError(`${name} already exists; choose another with to`);
  }
  const own = destination(name, { ...world, own: undefined });
  const byName = new Map(world.known.map((collection) => [collection.name, collection]));
  const set = moveSet(world.known);
  // Commanders first in the deck's own list, then the rest, as deck:build wrote it.
  const takes = plan.takes.toSorted((first, second) => Number(second.isCommander) - Number(first.isCommander));
  for (const take of takes) {
    set.take(byName.get(take.row.collection), take);
    set.put(own, { card: take.card, finish: take.row.finish, quantity: take.quantity, tracked: true });
  }
  for (const { card, quantity } of plan.untracked) set.put(own, { card, finish: 'normal', quantity, tracked: false });
  const lines = [
    ...planLines(set, args.apply ? { take: 'Took', put: 'Put' } : { take: 'Would take', put: 'Would put' }),
    ...(plan.untracked.length ? ['(cards listed by name alone are untracked basics, from unlimited_basics)'] : []),
    ...(await affectedDrafts(db, user.id, args.slug, plan, world.decks, world.index)),
  ];
  const warnings = isProtectedPath(own.path)
    ? []
    : [`${name} isn't protected, so other decks could count its cards; a name under decks/ is`];
  if (!args.apply) {
    return notApplied(
      [...lines, `Would create ${name} and mark ${args.slug} built.`],
      'once the person has sleeved the deck',
    );
  }
  const doc = { ...deck, status: 'built', collection_destination: own.path };
  await applyMoves(db, user.id, set, { source: 'build_deck', deck: { slug: args.slug, updatedAt, doc }, now });
  return textResult([...lines, `Built ${args.slug}: its cards are now in ${name}.`], warnings);
}

// The text lists a torn-down or swapped-out card goes back to: lands to lands_to when it's given.
function returnTarget(card, targets) {
  return targets.landsTo && isLand(card) ? targets.landsTo : targets.to;
}

function ownList(world, deck) {
  const own = world.collections.sources.find((source) => source.path === deck.collection_destination);
  const stored = world.known.find((collection) => collection.path === deck.collection_destination);
  if (!own || !stored) throw new ToolError(`The deck's own list ${deck.collection_destination} is missing`);
  return { own, stored };
}

async function teardownDeck(args, { db, user, now }) {
  const { deck, updatedAt } = await loadDeck(db, user.id, args.slug);
  if (!deck.collection_destination) throw new ToolError(`${args.slug} isn't built`);
  const world = await deckWorld(db, user.id, deck, { now });
  const { own, stored } = ownList(world, deck);
  const unmatched = own.rows.filter((row) => row.set && !row.scryfallId);
  if (unmatched.length) {
    throw new ToolError(
      `${stored.name} has lines that match no printing: ${unmatched.map((row) => row.name).join(', ')}`,
    );
  }
  const context = { ...world, own: deck.collection_destination };
  const targets = { to: destination(args.to, context), landsTo: args.lands_to && destination(args.lands_to, context) };
  const set = moveSet(world.known);
  const untracked = [];
  for (const row of own.rows) {
    const card = world.index.byId.get(row.scryfallId);
    if (!row.set) {
      untracked.push(`  ${row.quantity} ${row.name}`);
      continue;
    }
    set.put(returnTarget(card, targets), { card, finish: row.finish, quantity: row.quantity, tracked: true });
  }
  set.remove(stored);
  const lines = [
    ...planLines(set, args.apply ? { put: 'Returned' } : { put: 'Would return' }),
    ...(untracked.length ? ['Untracked basics (unlimited_basics), returned nowhere:', ...untracked] : []),
  ];
  const warnings = Object.values(targets)
    .filter((target) => target && isProtectedPath(target.path))
    .map((target) => `${target.name} is protected, so no deck will count the returned cards`);
  const doc = { ...deck, status: deck.status === 'built' ? 'draft' : deck.status };
  delete doc.collection_destination;
  if (!args.apply) {
    return notApplied(
      [...lines, `Would delete ${stored.name} and make ${args.slug} a draft again.`],
      'once the person has taken the deck apart',
    );
  }
  await applyMoves(db, user.id, set, { source: 'teardown_deck', deck: { slug: args.slug, updatedAt, doc }, now });
  return textResult(
    [...lines, `Tore down ${args.slug}: deleted ${stored.name}, and the deck is a draft again.`],
    warnings,
  );
}

// Each swap's out and in cards, with the copies each out card loses; refuses more than the mainboard has.
function swapPairs(deck, args, index) {
  if (args.out.length !== args.in.length) throw new ToolError('Give one in card for each out card');
  if (args.reasons && args.reasons.length !== args.out.length) {
    throw new ToolError('Give one reason for each swap, or none');
  }
  const lookup = (name) => {
    const { card, problem } = index.lookup({ name });
    if (problem) throw new ToolError(problem.replace(/; run scryfall:refresh.*$/, ''));
    return card;
  };
  const pairs = args.out.map((out, position) => ({ out: lookup(out), in: lookup(args.in[position]) }));
  const mainboard = resolveEntries(deck.mainboard, index).tallies;
  const cuts = new Map();
  for (const pair of pairs) {
    if (pair.out.oracleId === pair.in.oracleId) throw new ToolError(`${pair.out.name} can't be swapped for itself`);
    const { quantity: has = 0, printingId } = mainboard.get(pair.out.oracleId) ?? {};
    const cut = cuts.get(pair.out.oracleId) ?? { card: pair.out, quantity: 0, printingId };
    cut.quantity += 1;
    if (cut.quantity > has) {
      throw new ToolError(`${pair.out.name}: the mainboard has ${has}, fewer than the ${cut.quantity} to swap out`);
    }
    cuts.set(pair.out.oracleId, cut);
  }
  return { pairs, cuts };
}

// Upgrades a swap leaves stale, as deck:swap warned about them.
function staleUpgrades(swapped, pairs, index) {
  const mainboard = resolveEntries(swapped.mainboard, index).tallies;
  const outs = new Set(pairs.map((pair) => pair.out.oracleId));
  const ins = new Set(pairs.map((pair) => pair.in.oracleId));
  return (swapped.upgrades ?? []).flatMap(({ add, cut }) => {
    const [added, removed] = [add, cut].map((entry) => index.lookup(entry).card);
    const stale = [];
    if (removed && outs.has(removed.oracleId) && (mainboard.get(removed.oracleId)?.quantity ?? 0) < cut.quantity) {
      stale.push(`the upgrade adding ${add.name} cuts ${cut.name}, which the swap takes out; give it another cut`);
    }
    if (added && ins.has(added.oracleId)) stale.push(`the upgrade adding ${add.name} is done by the swap; remove it`);
    return stale;
  });
}

// The deck after the swaps, as update_deck's swap makes it.
function swappedDeck(deck, swaps, { reasons, now }) {
  try {
    return withMainboardSwaps(serializeDeck(deck), swaps, { date: today(now), reasons }).deck;
  } catch (error) {
    throw new ToolError(error.message);
  }
}

// The copies a built deck's swap moves: each in card from the other available collections into the
// deck's own list, and each out card from that list back to args.to (lands to args.lands_to).
function swapMoves(deck, world, { pairs, cuts }, args) {
  const { own, stored } = ownList(world, deck);
  const outPlan = planSwapOut(own.rows, cuts, world.index);
  const elsewhere = { available: world.collections.available.filter((row) => row.collection !== own.name) };
  const ins = pairs.map((pair) => ({ name: pair.in.name, quantity: 1 }));
  const inPlan = planBuild({ ...deck, commanders: [], mainboard: ins }, elsewhere, world.index);
  const problems = [...outPlan.problems, ...inPlan.problems];
  if (problems.length) return { problems };
  if (outPlan.takes.length && !args.to) {
    throw new ToolError('Name the collection the swapped-out cards go back to with to');
  }
  const context = { ...world, own: deck.collection_destination };
  const targets = args.to
    ? { to: destination(args.to, context), landsTo: args.lands_to && destination(args.lands_to, context) }
    : {};
  const byName = new Map(world.known.map((collection) => [collection.name, collection]));
  const set = moveSet(world.known);
  for (const take of inPlan.takes) {
    set.take(byName.get(take.row.collection), take);
    set.put(stored, { card: take.card, finish: take.row.finish, quantity: take.quantity, tracked: true });
  }
  for (const { card, quantity } of inPlan.untracked) {
    set.put(stored, { card, finish: 'normal', quantity, tracked: false });
  }
  for (const take of outPlan.takes) {
    set.take(stored, take);
    set.put(returnTarget(take.card, targets), {
      card: take.card,
      finish: take.row.finish,
      quantity: take.quantity,
      tracked: true,
    });
  }
  for (const { row, quantity } of outPlan.untracked) set.take(stored, { row, card: { name: row.name }, quantity });
  return { problems, set };
}

async function swapDeck(args, { db, user, now }) {
  const { deck, updatedAt } = await loadDeck(db, user.id, args.slug);
  if (!deck.collection_destination) {
    throw new ToolError(`${args.slug} isn't built, so no physical cards move; use update_deck with a swap operation`);
  }
  const world = await deckWorld(db, user.id, deck, { names: [...args.out, ...args.in], now });
  const pairs = swapPairs(deck, args, world.index);
  const swaps = pairs.pairs.map((pair) => ({ out: pair.out.name, in: pair.in.name }));
  const reasons = args.reasons ?? [];
  const swapped = swappedDeck(deck, swaps, { reasons, now });
  const report = checkDeck(swapped, world.collections, world.index, { now });
  if (baselineOutcome(report) !== 'pass') {
    return textResult([
      ...checkLines(args.slug, report),
      `Not swapped: ${args.slug} is built, so the swapped deck must pass check_deck.`,
    ]);
  }
  const { problems, set } = swapMoves(deck, world, pairs, args);
  if (problems.length) return textResult([...problems.map((problem) => `ERROR: ${problem}`), 'Not swapped.']);
  const bracketNotes = await recordBrackets(db, swapped, { listChanged: true, judged: false });
  const lines = [
    `${args.apply ? 'Swapped' : 'Would swap'} in the deck: ${swaps.map((swap) => `-1 ${swap.out}, +1 ${swap.in}`).join('; ')}`,
    ...planLines(set, args.apply ? { take: 'Took', put: 'Put' } : { take: 'Would take', put: 'Would put' }),
  ];
  const warnings = [
    ...(reasons.length
      ? []
      : ['No reasons given, so the swapped-out cards get no considered reason and deck_candidates will list them']),
    ...staleUpgrades(swapped, pairs.pairs, world.index),
  ];
  if (!args.apply) return notApplied(lines, 'once the person has swapped the physical cards');
  await applyMoves(db, user.id, set, { source: 'swap_deck', deck: { slug: args.slug, updatedAt, doc: swapped }, now });
  return textResult([...lines, ...bracketNotes], warnings);
}

const cardName = z.string().min(1).max(200);

export const PHYSICAL_TOOLS = [
  {
    name: 'build_deck',
    title: 'Build a deck physically',
    description:
      'When the person says they’ve sleeved a deck: move its cards out of the collections they were counted in and into a text list of its own (decks/<slug> by default, which is protected), and mark the deck built. The deck must pass check_deck with real (non-proxy) copies. Shows the plan unless apply is true.',
    schema: z
      .object({ slug, to: collectionName.optional().describe('The new list’s name; decks/<slug> by default'), apply })
      .strict(),
    annotations: WRITES,
    handler: buildDeck,
  },
  {
    name: 'teardown_deck',
    title: 'Tear down a built deck',
    description:
      'When the person says they’ve taken a built deck apart: return its cards from its own list to the collection they name (lands to lands_to, if given), delete the list, and make the deck a draft again. Shows the plan unless apply is true.',
    schema: z
      .object({
        slug,
        to: collectionName.describe('Where the cards go back to; a new text list if it doesn’t exist'),
        lands_to: collectionName.optional(),
        apply,
      })
      .strict(),
    annotations: WRITES,
    handler: teardownDeck,
  },
  {
    name: 'swap_deck',
    title: 'Swap cards in a built deck',
    description:
      'When the person says they’ve swapped physical cards in a built deck: one copy of each out card for the in card at the same place. The in cards move from the other collections into the deck’s own list, the out cards go back to to (lands to lands_to), and the deck records the swap with its reason. Shows the plan unless apply is true. For drafts, use update_deck.',
    schema: z
      .object({
        slug,
        out: z.array(cardName).min(1).max(20),
        in: z.array(cardName).min(1).max(20),
        reasons: z.array(z.string().min(1).max(500)).max(20).optional().describe('Why each out card left, in order'),
        to: collectionName.optional().describe('Where the swapped-out cards go back to'),
        lands_to: collectionName.optional(),
        apply,
      })
      .strict(),
    annotations: WRITES,
    handler: swapDeck,
  },
];
