// create_deck and update_deck: mtg-manager's deck:new, deck:swap and hand edits to deck.yaml, as
// structured changes. Every save validates against schemas/deck.schema.json and records
// lowest_legal_bracket from the cards, removing plays_like_bracket when the card list changed, as
// deck:files did. A save is refused if the deck changed since it was read.
import { z } from 'zod';
import { normalizeName } from '../../core/card.mjs';
import {
  applyUpgrades,
  newDeck,
  parseDeck,
  serializeDeck,
  validateDeck,
  withMainboardSwaps,
} from '../../core/deck.mjs';
import { pathMatches } from '../../core/glob.mjs';
import { lowestLegalBracket } from '../../core/rules.mjs';
import { cardIndexFor, loadCardRows, nameSuggester } from '../../storage/cards.mjs';
import { insertDeck, loadDeckForUpdate, saveDeck } from '../../storage/decks.mjs';
import { namesIn, slug } from './decks.mjs';
import { ToolError, textResult } from './shared.mjs';

const MAX_OPS = 200;
const cardName = z.string().min(1).max(200);
const text = z.string().min(1).max(4000);
const quantity = z.number().int().min(1).max(10000);
const role = z
  .string()
  .min(1)
  .max(100)
  .describe('land, ramp, draw, removal, wipe, protection, wincon or synergy; comma-separate several');
const money = z.object({ amount: z.number().min(0).max(1_000_000), currency: z.enum(['USD', 'EUR']) }).strict();
const bracket = z.number().int().min(1).max(5);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe('YYYY-MM-DD; today when left out');

// Fields set may change. lowest_legal_bracket is written from the cards, and collection_destination and
// status built belong to the physical-deck tools.
const SETTABLE_FIELDS = [
  'name',
  'format',
  'status',
  'primer',
  'notes',
  'power_notes',
  'target_bracket',
  'plays_like_bracket',
  'budget',
  'max_card_price',
  'role_targets',
  'allow_proxies',
  'unlimited_basics',
  'collection_source',
];
const roleTarget = z.object({
  min: z.number().int().min(0).max(200),
  max: z.number().int().min(0).max(200).optional(),
});
const fieldValue = z.union([
  z.string().max(20000),
  z.number(),
  z.boolean(),
  z.null(),
  money,
  z.array(z.string().min(1).max(200)).max(20),
  z.record(z.string().max(20), roleTarget.strict()),
]);

const operation = z.discriminatedUnion('op', [
  z
    .object({ op: z.literal('add'), name: cardName, quantity: quantity.default(1), role: role.optional() })
    .strict()
    .describe('Add copies to the mainboard (to an entry already there, or as a new one)'),
  z
    .object({
      op: z.literal('remove'),
      name: cardName,
      quantity: quantity.optional().describe('All copies when left out'),
      reason: text.optional().describe('Why it left; recorded as its considered reason'),
    })
    .strict(),
  z
    .object({ op: z.literal('swap'), out: cardName, in: cardName, reason: text })
    .strict()
    .describe('Swap one copy, as deck:swap: the in card takes the out card’s role, and history records it'),
  z.object({ op: z.literal('set_role'), name: cardName, role: role.nullable() }).strict(),
  z.object({ op: z.literal('set_commanders'), names: z.array(cardName).max(2) }).strict(),
  z.object({ op: z.literal('consider'), name: cardName, reason: text }).strict(),
  z.object({ op: z.literal('unconsider'), name: cardName }).strict(),
  z
    .object({
      op: z.literal('add_upgrade'),
      add: cardName,
      cut: cardName,
      reason: text,
      add_quantity: quantity.default(1),
      cut_quantity: quantity.default(1),
    })
    .strict(),
  z.object({ op: z.literal('remove_upgrade'), add: cardName }).strict(),
  z.object({ op: z.literal('add_history'), changes: text, notes: text.optional(), date }).strict(),
  z.object({ op: z.literal('add_playtest'), notes: text, changes: text.optional(), date }).strict(),
  z
    .object({ op: z.literal('set'), field: z.enum(SETTABLE_FIELDS), value: fieldValue })
    .strict()
    .describe('Set a deck field; null removes an optional one'),
]);

// collection_source holds path globs over binder paths (collections/<binder>.<txt or csv>), as mtg-manager
// matched collection files. People name binders, so a pattern that isn't already a path becomes one:
// precons/* becomes collections/precons/*.*. Globs become regexes, and stacked ** turn into nested repeats
// that can backtrack badly, so a pattern may hold only a few wildcards. One that doesn't compile is refused.
const MAX_GLOB_STARS = 4;
const binderGlob = (pattern) =>
  pattern === 'collections' || pattern.startsWith('collections/') ? pattern : `collections/${pattern}.*`;
function checkGlobs(names) {
  const patterns = names.map(binderGlob);
  for (const pattern of patterns) {
    if ((pattern.match(/\*/g) ?? []).length > MAX_GLOB_STARS) {
      throw new ToolError(`collection_source: ${pattern} has more than ${MAX_GLOB_STARS} * wildcards`);
    }
    try {
      pathMatches('collections/check.txt', pattern);
    } catch {
      throw new ToolError(`collection_source: ${pattern} is not a valid path pattern`);
    }
  }
  return patterns;
}

const sameName = (first, second) => normalizeName(first) === normalizeName(second);
const findEntry = (entries, name) => entries.find((entry) => sameName(entry.name, name));
const today = (now) => new Date(now).toISOString().slice(0, 10);

// The names an operation brings into the deck, which must be real cards.
const NEW_NAMES = {
  add: (op) => [op.name],
  swap: (op) => [op.in],
  set_commanders: (op) => op.names,
  consider: (op) => [op.name],
  add_upgrade: (op) => [op.add, op.cut],
};

// Each name as the card data spells it. Unknown names are refused, with suggestions.
async function canonicalNames(db, names) {
  const unique = [...new Set(names)];
  if (!unique.length) return new Map();
  const { index } = await cardIndexFor(db, await loadCardRows(db, { names: unique }));
  const canonical = new Map();
  const problems = [];
  for (const name of unique) {
    const { card, problem } = index.lookup({ name });
    if (card) canonical.set(name, card.name);
    else problems.push({ name, problem });
  }
  if (!problems.length) return canonical;
  const suggest = await nameSuggester(db);
  throw new ToolError(
    problems
      .map(({ name, problem }) => {
        if (/ambiguous/.test(problem)) return `${name}: more than one card has that name`;
        const suggestions = suggest(name);
        return suggestions.length
          ? `${name}: no card by that name; did you mean ${suggestions.join(', ')}?`
          : `${name}: no card by that name; check the spelling`;
      })
      .join('\n'),
  );
}

function setConsidered(deck, name, reason) {
  deck.considered = (deck.considered ?? []).filter((entry) => !sameName(entry.name, name));
  if (reason) deck.considered.push({ name, reason });
}

function mainboardEntry(deck, name) {
  const entry = findEntry(deck.mainboard, name);
  if (!entry) throw new ToolError(`The mainboard has no ${name}`);
  return entry;
}

// Each operation changes the deck in place and returns it (a swap returns a fresh one). named(name)
// gives a new card's spelling from the card data.
const OPERATIONS = {
  add(deck, op, { named }) {
    const name = named(op.name);
    const entry = findEntry(deck.mainboard, name);
    if (entry) {
      entry.quantity += op.quantity;
      if (op.role) entry.role = op.role;
    } else {
      deck.mainboard.push({ name, quantity: op.quantity, ...(op.role ? { role: op.role } : {}) });
    }
    setConsidered(deck, name);
    return deck;
  },
  remove(deck, op) {
    const entry = mainboardEntry(deck, op.name);
    if (op.quantity === undefined || op.quantity >= entry.quantity) {
      deck.mainboard = deck.mainboard.filter((candidate) => candidate !== entry);
    } else {
      entry.quantity -= op.quantity;
    }
    if (op.reason) setConsidered(deck, entry.name, op.reason);
    return deck;
  },
  swap(deck, op, { named, now }) {
    mainboardEntry(deck, op.out);
    const swap = { out: op.out, in: named(op.in) };
    return withMainboardSwaps(serializeDeck(deck), [swap], { date: today(now), reasons: [op.reason] }).deck;
  },
  set_role(deck, op) {
    const entry = mainboardEntry(deck, op.name);
    if (op.role === null) delete entry.role;
    else entry.role = op.role;
    return deck;
  },
  set_commanders(deck, op, { named }) {
    deck.commanders = op.names.map((name) => ({ name: named(name), quantity: 1 }));
    return deck;
  },
  consider(deck, op, { named }) {
    setConsidered(deck, named(op.name), op.reason);
    return deck;
  },
  unconsider(deck, op) {
    if (!findEntry(deck.considered ?? [], op.name)) throw new ToolError(`considered has no ${op.name}`);
    setConsidered(deck, op.name);
    return deck;
  },
  add_upgrade(deck, op, { named }) {
    const add = { name: named(op.add), quantity: op.add_quantity };
    const cut = { name: named(op.cut), quantity: op.cut_quantity };
    deck.upgrades = [...(deck.upgrades ?? []), { add, cut, reason: op.reason }];
    return deck;
  },
  remove_upgrade(deck, op) {
    const kept = (deck.upgrades ?? []).filter((upgrade) => !sameName(upgrade.add.name, op.add));
    if (kept.length === (deck.upgrades ?? []).length) throw new ToolError(`No upgrade adds ${op.add}`);
    deck.upgrades = kept;
    return deck;
  },
  add_history(deck, op, { now }) {
    const entry = { date: op.date ?? today(now), changes: op.changes, ...(op.notes ? { notes: op.notes } : {}) };
    deck.history = [...(deck.history ?? []), entry];
    return deck;
  },
  add_playtest(deck, op, { now }) {
    const entry = { date: op.date ?? today(now), notes: op.notes, ...(op.changes ? { changes: op.changes } : {}) };
    deck.playtests = [...(deck.playtests ?? []), entry];
    return deck;
  },
  set(deck, op) {
    if (op.field === 'status' && op.value === 'built') {
      throw new ToolError('A deck becomes built when build_deck moves its physical cards into a deck binder');
    }
    if (op.value === null) delete deck[op.field];
    else if (op.field === 'collection_source' && Array.isArray(op.value)) deck[op.field] = checkGlobs(op.value);
    else deck[op.field] = op.value;
    return deck;
  },
};

const applyOperation = (deck, op, { names, now }) =>
  OPERATIONS[op.op](deck, op, { named: (name) => names.get(name) ?? name, now });

// The card list as a comparable string: which cards, how many, commanders apart.
const cardList = (deck) =>
  [
    ...deck.commanders.map((entry) => `commander:${normalizeName(entry.name)}:${entry.quantity}`),
    ...deck.mainboard.map((entry) => `${normalizeName(entry.name)}:${entry.quantity}`),
  ]
    .sort()
    .join('\n');

function checked(deck, deckSlug) {
  try {
    validateDeck(deck, deckSlug);
    applyUpgrades(deck);
  } catch (error) {
    throw new ToolError(error.message);
  }
  return deck;
}

// Records lowest_legal_bracket from the cards (casual decks have none) and removes a plays_like_bracket
// judged for an older card list, unless this change set it. Returns the notes for the reply.
export async function recordBrackets(db, deck, { listChanged, judged }) {
  const { index } = await cardIndexFor(db, await loadCardRows(db, { names: namesIn(deck) }));
  const bracket = lowestLegalBracket(deck, index);
  const notes = [];
  if (bracket === undefined) delete deck.lowest_legal_bracket;
  else if (deck.lowest_legal_bracket !== bracket) {
    deck.lowest_legal_bracket = bracket;
    notes.push(`lowest_legal_bracket is now ${bracket}`);
  }
  if (listChanged && !judged && deck.plays_like_bracket !== undefined) {
    delete deck.plays_like_bracket;
    notes.push('removed plays_like_bracket because the card list changed; judge it again');
  }
  return notes;
}

const copies = (entries) => entries.reduce((sum, entry) => sum + entry.quantity, 0);
const sizeLine = (deck) =>
  `${copies(deck.commanders) + copies(deck.mainboard)} cards: ${copies(deck.commanders)} commanders, ${copies(deck.mainboard)} mainboard.`;

async function applyOperations(db, deck, ops, now) {
  const names = await canonicalNames(
    db,
    ops.flatMap((op) => NEW_NAMES[op.op]?.(op) ?? []),
  );
  let updated = structuredClone(deck);
  for (const op of ops) {
    try {
      updated = applyOperation(updated, op, { names, now });
    } catch (error) {
      // A swap's YAML edit throws plain Errors for problems with the request.
      throw new ToolError(`${op.op}: ${error.message}`);
    }
  }
  return updated;
}

export const createSchema = z
  .object({
    slug: slug.describe('A new slug: lowercase words joined by hyphens, e.g. kwia-lotus-engine'),
    name: z.string().min(1).max(200).optional().describe('Titled from the slug when left out'),
    format: z.enum(['commander', 'custom-dollar-brawl', 'casual-60']).default('commander'),
    commanders: z.array(cardName).max(2).default([]),
    primer: text.optional().describe('How the deck wins, in a sentence or two'),
    target_bracket: bracket.optional(),
    budget: money.optional(),
    max_card_price: money.optional(),
    allow_proxies: z.boolean().default(false),
    unlimited_basics: z.boolean().default(false).describe('The person has basics their collection doesn’t list'),
    collection_source: z
      .array(z.string().min(1).max(200))
      .min(1)
      .max(20)
      .optional()
      .describe('Only these binders supply cards: binder names, with * for any part of a name (e.g. precons/*)'),
    mainboard: z
      .array(z.object({ name: cardName, quantity: quantity.default(1), role: role.optional() }).strict())
      .max(150)
      .default([]),
  })
  .strict();

// Creates the deck and returns the reply's lines. import_deck creates decks through it too.
export async function createDeckLines(args, { db, user, now }) {
  const collectionSource = args.collection_source && checkGlobs(args.collection_source);
  const names = await canonicalNames(db, [...args.commanders, ...args.mainboard.map((entry) => entry.name)]);
  let deck;
  try {
    deck = newDeck(args.slug, {
      format: args.format,
      commanderNames: args.commanders.map((name) => names.get(name)),
      name: args.name,
      allowProxies: args.allow_proxies,
      unlimitedBasics: args.unlimited_basics,
      header: {
        primer: args.primer,
        target_bracket: args.target_bracket,
        budget: args.budget,
        max_card_price: args.max_card_price,
        collection_source: collectionSource,
      },
    });
  } catch (error) {
    throw new ToolError(error.message.replace('--commander "<name>" (repeat it for a partner pair)', 'commanders'));
  }
  for (const entry of args.mainboard) deck = applyOperation(deck, { op: 'add', ...entry }, { names, now });
  checked(deck, args.slug);
  const notes = await recordBrackets(db, deck, { listChanged: false, judged: false });
  if (!(await insertDeck(db, user.id, args.slug, deck, now))) {
    throw new ToolError(`A deck named ${args.slug} already exists; update_deck changes it`);
  }
  return [`Created ${args.slug} (${deck.format}, draft). ${sizeLine(deck)}`, ...notes];
}

const createDeck = async (args, ctx) => textResult(await createDeckLines(args, ctx));

const updateSchema = z
  .object({
    slug,
    ops: z.array(operation).min(1).max(MAX_OPS).describe('Changes, applied in order; all are saved or none'),
  })
  .strict();

// Changes the deck and returns the reply's lines. import_deck merges and replaces decks through it too.
export async function updateDeckLines(args, { db, user, now }) {
  const loaded = await loadDeckForUpdate(db, user.id, args.slug);
  if (!loaded) throw new ToolError(`No deck named ${args.slug}; list_decks shows yours`);
  const deck = checked(await applyOperations(db, loaded.deck, args.ops, now), args.slug);
  const listChanged = cardList(deck) !== cardList(loaded.deck);
  if (listChanged && loaded.deck.collection_destination) {
    throw new ToolError(
      `${args.slug} is built: its cards are in ${loaded.deck.collection_destination}. Change its cards only when the physical cards change`,
    );
  }
  const judged = args.ops.some((op) => op.op === 'set' && op.field === 'plays_like_bracket');
  const notes = await recordBrackets(db, deck, { listChanged, judged });
  // Reparsing proves the saved document is what a later load reads back.
  parseDeck(serializeDeck(deck), args.slug);
  if (!(await saveDeck(db, user.id, args.slug, deck, { updatedAt: loaded.updatedAt, now }))) {
    throw new ToolError(`${args.slug} changed while this was being saved; read it again and redo the changes`);
  }
  const count = args.ops.length;
  return [`Saved ${args.slug}: ${count} change${count === 1 ? '' : 's'}. ${sizeLine(deck)}`, ...notes];
}

const updateDeck = async (args, ctx) => textResult(await updateDeckLines(args, ctx));

const WRITES = { readOnlyHint: false, openWorldHint: false };

export const DECK_WRITE_TOOLS = [
  {
    name: 'create_deck',
    title: 'Create a deck',
    description:
      'Create a draft deck from the brief: format, commanders, target bracket, budget, price cap, ownership policies, primer, and optionally its first mainboard cards with roles. Card names are checked against the card data.',
    schema: createSchema,
    annotations: { ...WRITES, destructiveHint: false, idempotentHint: false },
    handler: createDeck,
  },
  {
    name: 'update_deck',
    title: 'Edit a deck',
    description:
      'Change a deck with a list of operations, all saved together or not at all: add, remove (with an optional considered reason), swap (recorded in history), set_role, set_commanders, consider, unconsider, add_upgrade, remove_upgrade, add_history, add_playtest, and set for fields such as primer, notes, power_notes, plays_like_bracket, budget and role_targets. Built decks keep their card list. lowest_legal_bracket is recorded on every save.',
    schema: updateSchema,
    annotations: { ...WRITES, destructiveHint: true, idempotentHint: false },
    handler: updateDeck,
  },
];
