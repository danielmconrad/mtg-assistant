import { parseDocument, stringify } from 'yaml';
import { normalizeName } from './card.mjs';
import validateSchema from './deck-validator.generated.mjs';
import { isCommanderFormat } from './formats.mjs';

// Deck objects mirror the YAML document, so they keep its snake_case field names.

const MAX_YAML_ALIASES = 50;
// The editor schema path is relative to the deck file; the default fits builds/<slug>/deck.yaml.
const DEFAULT_SCHEMA_PATH = '../../schemas/deck.schema.json';
export const PRIMER_PLACEHOLDER = 'Describe the game plan.';

export const deckEntries = (deck) => [...deck.commanders, ...deck.mainboard];

// Decks that commands mention unprompted: not the example template, and not archived decks, which the
// user has given up on building and doesn't want named in reports.
const QUIET_STATUSES = new Set(['example', 'archived']);
export const isActiveDeck = (deck) => Boolean(deck) && !QUIET_STATUSES.has(deck.status);

export function parseDeck(text, source = 'deck') {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) throw new Error(`${source}: ${document.errors.map((error) => error.message).join('; ')}`);
  return validateDeck(document.toJS({ maxAliasCount: MAX_YAML_ALIASES }), source);
}

// Checks a deck object against schemas/deck.schema.json (compiled ahead of time, since Workers can't
// compile schemas at runtime) and returns it, or throws naming every problem.
export function validateDeck(deck, source = 'deck') {
  if (!validateSchema(deck)) {
    throw new Error(
      `${source}: ${validateSchema.errors.map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ')}`,
    );
  }
  return deck;
}

export const serializeDeck = (deck, { schemaPath = DEFAULT_SCHEMA_PATH } = {}) =>
  `# yaml-language-server: $schema=${schemaPath}\n${stringify(deck, { lineWidth: 0 })}`;

// Adds a top-level field to a deck file's text, after the field named by after if it's there, else at
// the end. Editing the YAML document rather than reserializing the deck keeps comments and quoting.
export function withDeckField(text, key, value, { after, source = 'deck' } = {}) {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.has(key)) throw new Error(`${source} already has ${key}`);
  const { items } = document.contents;
  const position = items.findIndex((pair) => pair.key?.value === after);
  items.splice(position === -1 ? items.length : position + 1, 0, document.createPair(key, value));
  const updated = document.toString({ lineWidth: 0 });
  parseDeck(updated, source);
  return updated;
}

// Sets one top-level field of a deck file's text: in place if it's there, else after the field named
// by after (or at the end). An undefined value removes it. Comments and quoting are kept.
export function withDeckValue(text, key, value, { after, source = 'deck' } = {}) {
  const document = parseDocument(text, { uniqueKeys: true });
  if (value === undefined && !document.has(key)) return text;
  if (document.has(key) || value === undefined) return withDeckChanges(text, { [key]: value }, { source });
  return withDeckField(text, key, value, { after, source });
}

// Changes fields of a deck's deck.yaml in place, keeping its comments and field order: each key is set
// to its value, or removed when the value is undefined. The result must still be a valid deck.
export function withDeckChanges(text, changes, { source = 'deck' } = {}) {
  const document = parseDocument(text, { uniqueKeys: true });
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) document.delete(key);
    else document.set(key, value);
  }
  const updated = document.toString({ lineWidth: 0 });
  parseDeck(updated, source);
  return updated;
}

// Comments before a removed mainboard entry, such as a role group heading, move to the entry after it.
function removeItem(items, position) {
  const [removed] = items.splice(position, 1);
  const next = items[position];
  if (removed.commentBefore && next) {
    next.commentBefore = [removed.commentBefore, next.commentBefore].filter(Boolean).join('\n');
    next.spaceBefore ||= removed.spaceBefore;
  }
}

// A top-level list in a deck document, created after the field named by after (else at the end) if
// the deck doesn't have one yet.
function deckList(document, key, after) {
  if (!document.has(key)) {
    const { items } = document.contents;
    const position = items.findIndex((pair) => pair.key?.value === after);
    items.splice(position === -1 ? items.length : position + 1, 0, document.createPair(key, []));
  }
  return document.get(key);
}

// Records a swap: each out card with a reason gets that considered reason (replacing an older one),
// each in card loses its considered entry since it's in the deck now, and history gains an entry.
function recordSwaps(document, swaps, { date, reasons = [] }) {
  const considered = deckList(document, 'considered', 'mainboard');
  const named = (names) => (item) => names.some((name) => normalizeName(item.get('name')) === normalizeName(name));
  const replaced = [...swaps.map((swap) => swap.in), ...swaps.filter((_, at) => reasons[at]).map((swap) => swap.out)];
  considered.items = considered.items.filter((item) => !named(replaced)(item));
  swaps.forEach((swap, at) => {
    if (reasons[at]) considered.items.push(document.createNode({ name: swap.out, reason: reasons[at] }));
  });
  if (!considered.items.length) document.delete('considered');
  const changes = swaps.map((swap) => `-${swap.out}, +${swap.in}`).join(', ');
  const notes = reasons.filter(Boolean).join(' ');
  deckList(document, 'history', 'upgrades').items.push(
    document.createNode({ date, changes, ...(notes ? { notes } : {}) }),
  );
}

// Swaps one copy of each out card for one copy of its in card in a deck file's mainboard, keeping
// comments. A card already in the mainboard gains a copy; a new one takes the out card's place and
// role. An out entry left with no copies is removed. With a date, the swap is recorded in considered
// and history (see recordSwaps). The result must still be a valid deck.
export function withMainboardSwaps(text, swaps, { source = 'deck', date, reasons } = {}) {
  const document = parseDocument(text, { uniqueKeys: true });
  const { items } = document.get('mainboard');
  const position = (name) => items.findIndex((item) => normalizeName(item.get('name')) === normalizeName(name));
  for (const swap of swaps) {
    const from = position(swap.out);
    if (from === -1) throw new Error(`${source}: the mainboard has no ${swap.out}`);
    const cut = items[from];
    const existing = items[position(swap.in)];
    if (existing) {
      existing.set('quantity', existing.get('quantity') + 1);
    } else {
      const role = cut.get('role');
      items.splice(from + 1, 0, document.createNode({ name: swap.in, quantity: 1, ...(role ? { role } : {}) }));
    }
    if (cut.get('quantity') > 1) cut.set('quantity', cut.get('quantity') - 1);
    else removeItem(items, items.indexOf(cut));
  }
  if (date) recordSwaps(document, swaps, { date, reasons });
  const updated = document.toString({ lineWidth: 0 });
  return { text: updated, deck: parseDeck(updated, source) };
}

// A nested slug (brad/green-value) is titled from its last part.
const titleFromSlug = (slug) =>
  slug
    .split('/')
    .at(-1)
    .split('-')
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');

// The fields given a value, in order; the rest are left out.
const definedFields = (fields) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

// A new draft. The brief's answers fill the header: header holds target_bracket, budget, max_card_price,
// collection_source and primer when they're known, and the two ownership policies default to false.
export function newDeck(
  slug,
  {
    format = 'commander',
    commanderNames = [],
    name = titleFromSlug(slug),
    allowProxies = false,
    unlimitedBasics = false,
    header = {},
  } = {},
) {
  if (isCommanderFormat(format) && !commanderNames.length) {
    throw new Error('Commander decks need --commander "<name>" (repeat it for a partner pair)');
  }
  const {
    primer = PRIMER_PLACEHOLDER,
    target_bracket: targetBracket,
    budget,
    max_card_price: maxCardPrice,
    collection_source: source,
  } = header;
  const deck = {
    schema_version: 1,
    name,
    format,
    status: 'draft',
    ...definedFields({ target_bracket: targetBracket }),
    allow_proxies: allowProxies,
    unlimited_basics: unlimitedBasics,
    primer,
    ...definedFields({ budget, max_card_price: maxCardPrice, collection_source: source }),
    commanders: commanderNames.map((commanderName) => ({ name: commanderName, quantity: 1 })),
    mainboard: [],
    considered: [],
    upgrades: [],
    history: [],
    playtests: [],
  };
  parseDeck(serializeDeck(deck), `new deck ${slug}`);
  return deck;
}

const findEntry = (entries, name) => entries.find((entry) => normalizeName(entry.name) === normalizeName(name));

// Takes a swap's cut out of a copied mainboard and returns the entry it came from.
function takeCut(mainboard, cut) {
  const target = findEntry(mainboard, cut.name);
  if (!target || target.quantity < cut.quantity) {
    throw new Error(`Upgrade cuts ${cut.quantity} ${cut.name}, but the mainboard has ${target?.quantity ?? 0}`);
  }
  target.quantity -= cut.quantity;
  return target;
}

// The deck as it would be with every upgrade swap made. The added cards are kept apart in
// upgradesIn, still part of the deck, so text and Archidekt exports can mark them.
// A later swap may cut an earlier add.
export function applyUpgrades(deck) {
  let mainboard = deck.mainboard.map((entry) => ({ ...entry }));
  let upgradesIn = [];
  for (const { add, cut } of deck.upgrades ?? []) {
    takeCut(findEntry(mainboard, cut.name) ? mainboard : upgradesIn, cut);
    const existing = findEntry(upgradesIn, add.name);
    if (existing) existing.quantity += add.quantity;
    else upgradesIn.push({ ...add });
    mainboard = mainboard.filter((entry) => entry.quantity > 0);
    upgradesIn = upgradesIn.filter((entry) => entry.quantity > 0);
  }
  return { ...deck, mainboard, upgradesIn };
}

// The baseline deck split for review: swapOut holds the copies the upgrades would cut, keeping
// their roles, and considering holds the cards the upgrades would add.
export function splitUpgrades(deck) {
  const mainboard = deck.mainboard.map((entry) => ({ ...entry }));
  const swapOut = [];
  for (const { cut } of deck.upgrades ?? []) {
    const target = takeCut(mainboard, cut);
    const existing = findEntry(swapOut, cut.name);
    if (existing) existing.quantity += cut.quantity;
    else swapOut.push({ ...target, quantity: cut.quantity });
  }
  return {
    ...deck,
    mainboard: mainboard.filter((entry) => entry.quantity > 0),
    swapOut,
    considering: (deck.upgrades ?? []).map(({ add }) => ({ ...add })),
  };
}

// The labels a card entry's role may use; deck:check notes any other.
export const ROLE_VOCABULARY = ['land', 'ramp', 'draw', 'removal', 'wipe', 'protection', 'wincon', 'synergy'];

// A card entry's role field holds comma-separated labels, e.g. "ramp, draw".
export const roleLabels = (entry) =>
  (entry.role ?? '')
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean);

// A tally is every copy of one card in a list, keyed by oracle ID so printings merge.
// printingId records a scryfall_id the deck pinned, which pricing honors.
export function addCopies(tallies, card, quantity, printingId) {
  const tally = tallies.get(card.oracleId) ?? { card, quantity: 0, printingId: undefined };
  tally.quantity += quantity;
  tally.printingId ??= printingId;
  tallies.set(card.oracleId, tally);
}

export function removeCopies(tallies, card, quantity) {
  const tally = tallies.get(card.oracleId);
  if ((tally?.quantity ?? 0) < quantity) {
    throw new Error(`${card.name}: cannot remove ${quantity}; the list has ${tally?.quantity ?? 0}`);
  }
  tally.quantity -= quantity;
}

export function resolveEntries(entries, index) {
  const tallies = new Map();
  const problems = [];
  for (const entry of entries) {
    const { card, problem } = index.lookup(entry);
    if (problem) problems.push(problem);
    else addCopies(tallies, card, entry.quantity, entry.scryfall_id);
  }
  return { tallies, problems };
}
