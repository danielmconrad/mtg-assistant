// import_deck: a draft deck from a public Archidekt deck or a pasted list. Archidekt has a public JSON API;
// Moxfield refuses requests that don't come from a browser, so its decks come in as their text export.
// Either way the cards are checked against the card data and the deck is saved as draft_deck saves it.
import { z } from 'zod';
import { canBeCommander, normalizeName } from '../../core/card.mjs';
import { OutboundRefused, boundedJson, outboundFetch } from '../../outbound.mjs';
import { resolvedRows } from './collection-writes.mjs';
import { listCollections } from '../../storage/collections.mjs';
import { entriesFor } from '../../storage/collection-writes.mjs';
import { loadAllDecks, loadDeckForUpdate } from '../../storage/decks.mjs';
import { draftDeckLines, draftSchema, updateDeckLines } from './deck-writes.mjs';
import { slug } from './decks.mjs';
import { ToolError, personalIndex, textResult } from './shared.mjs';

const MAX_LIST_CHARS = 20_000;
const ARCHIDEKT_URL = /^https:\/\/(?:www\.)?archidekt\.com\/decks\/(\d{1,12})(?:[/?#]|$)/;

// Where a line's cards go. Commander and companion headings are Arena's and Moxfield's; Archidekt's text
// export marks commanders with [Commander] and cards outside the deck with {noDeck}.
const HEADINGS = [
  [/^commanders?:?$/i, 'commander'],
  [/^(?:deck|main|mainboard):?$/i, 'main'],
  [/^(?:companion|sideboard|maybeboard|considering|tokens?):?$/i, 'out'],
];
const ARENA_ABOUT = /^(?:about|name\s.*)$/i;
const ANNOTATION = /\[([^\]]*)\]\s*(?:\^[^^]*\^\s*)?$/;

// Archidekt categories that name one of the deck's roles.
const ROLES = {
  land: 'land',
  lands: 'land',
  ramp: 'ramp',
  draw: 'draw',
  'card draw': 'draw',
  'card advantage': 'draw',
  removal: 'removal',
  'board wipe': 'wipe',
  'board wipes': 'wipe',
  wipe: 'wipe',
  protection: 'protection',
  finisher: 'wincon',
  'win condition': 'wincon',
  wincon: 'wincon',
};

const schema = z
  .object({
    url: z
      .string()
      .max(300)
      .optional()
      .describe('A public Archidekt deck, e.g. https://archidekt.com/decks/123456/name'),
    list: z
      .string()
      .min(1)
      .max(MAX_LIST_CHARS)
      .optional()
      .describe(
        'A pasted deck list, as Moxfield, Archidekt and Arena export it, with Commander/Deck/Sideboard headings',
      ),
    binder: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('A deck binder from collection_summary, such as a ManaBox deck: saved as a built deck of its cards'),
    mode: z
      .enum(['new', 'merge', 'replace'])
      .default('new')
      .describe(
        'new (default): a new draft deck; merge: add the cards to the draft deck slug names; replace: that draft’s cards become the import’s',
      ),
    slug: slug
      .optional()
      .describe(
        'The deck’s slug. For a new deck, from the Archidekt deck’s or binder’s name when left out (required for a list); for merge and replace, the existing deck',
      ),
    name: z.string().min(1).max(200).optional(),
    format: z
      .enum(['commander', 'custom-dollar-brawl', 'casual-60'])
      .optional()
      .describe('commander when the list has commanders, casual-60 otherwise'),
    commanders: z
      .array(z.string().min(1).max(200))
      .max(2)
      .optional()
      .describe('The commanders, when the list doesn’t mark them; they are taken out of the mainboard'),
    target_bracket: z.number().int().min(1).max(5).optional(),
    allow_proxies: z.boolean().default(false),
    unlimited_basics: z.boolean().default(false),
  })
  .strict();

const slugFrom = (name) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/, '');

// Sums copies of a card listed more than once, as different printings often are.
function addCopies(entries, name, quantity, role) {
  const entry = entries.find((candidate) => normalizeName(candidate.name) === normalizeName(name));
  if (entry) entry.quantity += quantity;
  else entries.push({ name, quantity, ...(role ? { role } : {}) });
}

function annotationSection(line) {
  const annotation = line.match(ANNOTATION)?.[1];
  if (!annotation) return undefined;
  if (/\{noDeck\}/i.test(annotation)) return 'out';
  return /^commander\b/i.test(annotation) ? 'commander' : undefined;
}

// The list's cards by section. Heading lines are blanked rather than removed, so each row's position
// stays its line's index.
async function fromList(db, list) {
  const sections = [];
  let section = 'main';
  const lines = list
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((rawLine, index) => {
      const line = rawLine.trim();
      const heading = HEADINGS.find(([pattern]) => pattern.test(line));
      if (heading) [, section] = heading;
      sections[index] = annotationSection(line) ?? section;
      return heading || ARENA_ABOUT.test(line) ? '' : line;
    });
  const { rows } = await resolvedRows(db, lines.join('\n'), 'list');
  const deck = { commanders: [], mainboard: [], leftOut: 0 };
  for (const row of rows) {
    const where = sections[row.position];
    if (where === 'out') deck.leftOut += row.quantity;
    else addCopies(where === 'commander' ? deck.commanders : deck.mainboard, row.name, row.quantity);
  }
  return deck;
}

function archidektShape(body) {
  const ok =
    body &&
    typeof body.name === 'string' &&
    Array.isArray(body.cards) &&
    body.cards.every(
      (entry) =>
        Number.isSafeInteger(entry?.quantity) &&
        entry.quantity > 0 &&
        typeof entry.card?.oracleCard?.name === 'string' &&
        (entry.categories === undefined || entry.categories === null || Array.isArray(entry.categories)),
    );
  if (!ok) throw new ToolError('Archidekt sent a deck in a shape this server doesn’t recognize');
  return body;
}

async function fetchArchidekt(env, user, url) {
  const id = url.match(ARCHIDEKT_URL)?.[1];
  if (!id) throw new ToolError('Only Archidekt deck links (https://archidekt.com/decks/<number>/…) can be fetched');
  const { success } = await env.RL_IMPORT.limit({ key: user.id });
  if (!success) throw new ToolError('Too many imports just now; try again in a minute');
  let response;
  try {
    response = await outboundFetch(`https://archidekt.com/api/decks/${id}/`, {
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    if (error instanceof OutboundRefused) throw new ToolError(`Archidekt: ${error.message}`);
    throw new ToolError('Archidekt could not be reached; try again, or paste the deck’s text export as list');
  }
  if ([401, 403, 404].includes(response.status)) {
    throw new ToolError(`Archidekt deck ${id} is private or doesn’t exist; paste its text export as list instead`);
  }
  if (!response.ok) throw new ToolError(`Archidekt answered ${response.status}; try again later`);
  try {
    return archidektShape(await boundedJson(response));
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(`Archidekt: ${error.message}`);
  }
}

// An Archidekt deck's cards by section. A card's first category decides where it goes, as on Archidekt:
// a category outside the deck (Maybeboard, Sideboard) leaves it out.
function fromArchidekt(body) {
  const outside = new Set(
    (Array.isArray(body.categories) ? body.categories : [])
      .filter((category) => category?.includedInDeck === false)
      .map((category) => String(category.name)),
  );
  const deck = { name: body.name, commanders: [], mainboard: [], leftOut: 0 };
  for (const entry of body.cards) {
    const categories = (entry.categories ?? []).map(String);
    const name = entry.card.oracleCard.name;
    if (categories.some((category) => /^commander$/i.test(category))) addCopies(deck.commanders, name, entry.quantity);
    else if (categories.length && outside.has(categories[0])) deck.leftOut += entry.quantity;
    else addCopies(deck.mainboard, name, entry.quantity, ROLES[categories[0]?.toLowerCase()]);
  }
  return deck;
}

// Named commanders come out of the mainboard, wherever the list put them.
function withCommanders(deck, names) {
  if (!names?.length) return deck;
  const named = new Set(names.map(normalizeName));
  return {
    ...deck,
    commanders: names.map((name) => ({ name, quantity: 1 })),
    mainboard: deck.mainboard
      .map((entry) => (named.has(normalizeName(entry.name)) ? { ...entry, quantity: entry.quantity - 1 } : entry))
      .filter((entry) => entry.quantity > 0),
  };
}

// draft_deck's arguments for the imported cards.
function createArgs(args, source) {
  const deck = withCommanders(source, args.commanders);
  const deckSlug = args.slug ?? (source.name && slugFrom(source.name));
  if (!deckSlug) throw new ToolError('Pass slug: the new deck’s name as lowercase words joined by hyphens');
  if (!deck.mainboard.length && !deck.commanders.length) throw new ToolError('The deck has no cards');
  const parsed = draftSchema.safeParse({
    slug: deckSlug,
    name: args.name ?? source.name,
    format: args.format ?? (deck.commanders.length ? 'commander' : 'casual-60'),
    commanders: deck.commanders.map((entry) => entry.name),
    target_bracket: args.target_bracket,
    allow_proxies: args.allow_proxies,
    unlimited_basics: args.unlimited_basics,
    mainboard: deck.mainboard,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ToolError(`The imported deck doesn’t fit a deck: ${issue.path.join('.')}: ${issue.message}`);
  }
  return parsed.data;
}

// update_deck's operations for merging the imported cards into a deck, or replacing its cards with them.
// Merging keeps the deck's commanders, setting them only when it has none; replacing takes the import's,
// if it names any.
function updateOps(existing, imported, replace) {
  const ops = replace ? existing.mainboard.map((entry) => ({ op: 'remove', name: entry.name })) : [];
  ops.push(...imported.mainboard.map((entry) => ({ op: 'add', quantity: 1, ...entry })));
  const names = imported.commanders.map((entry) => entry.name);
  if (names.length && (replace || !existing.commanders.length)) ops.push({ op: 'set_commanders', names });
  return ops;
}

async function intoDeck(args, imported, { db, user, now }) {
  if (!args.slug) throw new ToolError(`Pass slug: the deck to ${args.mode}`);
  const loaded = await loadDeckForUpdate(db, user.id, args.slug);
  if (!loaded) throw new ToolError(`No deck named ${args.slug}; list_decks shows yours`);
  if (!imported.mainboard.length && !imported.commanders.length) throw new ToolError('The import has no cards');
  const ops = updateOps(loaded.deck, imported, args.mode === 'replace');
  const lines = await updateDeckLines({ slug: args.slug, ops }, { db, user, now });
  const kept = imported.commanders.length && args.mode === 'merge' && loaded.deck.commanders.length;
  if (kept) lines.push('Kept the deck’s commanders; replace takes the import’s.');
  return lines;
}

// The person's deck binder by name, refused when it's an ordinary binder or already a built deck's.
async function deckBinder(args, { db, user }) {
  if (args.mode !== 'new') throw new ToolError('A binder becomes a new built deck; leave mode out');
  const [binders, decks] = await Promise.all([listCollections(db, user.id), loadAllDecks(db, user.id)]);
  const binder = binders.find((candidate) => candidate.name === args.binder);
  if (!binder) throw new ToolError(`No binder named ${args.binder}; collection_summary lists them`);
  if (binder.kind !== 'deck') throw new ToolError(`${args.binder} isn’t a deck binder; collection_summary marks them`);
  const builtAs = decks.find(({ deck }) => deck.collection_destination === binder.path);
  if (builtAs) throw new ToolError(`${args.binder} is already the built deck ${builtAs.slug}`);
  return binder;
}

// A binder's rows as a deck's mainboard, with the cards that could be its commander.
function binderCards(binder, entries, index) {
  // A binder named precons/Draconic Destruction names its deck Draconic Destruction.
  const deck = { name: binder.name.split('/').at(-1), commanders: [], mainboard: [], leftOut: 0, proxies: false };
  const candidates = new Set();
  for (const entry of entries) {
    const card = entry.scryfall_id && index.byId.get(entry.scryfall_id);
    addCopies(deck.mainboard, card?.name ?? entry.name, entry.quantity);
    if (card && canBeCommander(card)) candidates.add(card.name);
    if (entry.is_proxy) deck.proxies = true;
  }
  return { deck, candidates: [...candidates] };
}

// A deck binder's cards as a deck: a ManaBox deck, already built, whose binder becomes the deck's own. Its
// commanders are the ones named, or its only card that can be a commander.
async function fromBinder(args, { db, user }) {
  const binder = await deckBinder(args, { db, user });
  const entries = await entriesFor(db, user.id, binder.id);
  if (!entries.length) throw new ToolError(`${args.binder} is empty`);
  const { index } = await personalIndex(db, user.id, { names: entries.map((entry) => entry.name) });
  const { deck, candidates } = binderCards(binder, entries, index);
  if (args.commanders || (args.format ?? 'commander') !== 'commander') return { deck, path: binder.path };
  if (candidates.length !== 1) {
    const which = candidates.length ? `; its cards that can be one: ${candidates.join(', ')}` : '';
    throw new ToolError(`Name the commanders of ${args.binder}${which}`);
  }
  return { deck: withCommanders(deck, candidates), path: binder.path, guessed: candidates[0] };
}

async function importBinderDeck(args, context) {
  const { deck, path, guessed } = await fromBinder(args, context);
  const parsed = createArgs({ ...args, format: args.format ?? 'commander' }, deck);
  const lines = await draftDeckLines({ ...parsed, allow_proxies: parsed.allow_proxies || deck.proxies }, context, {
    builtInto: path,
  });
  if (guessed) lines.push(`Took ${guessed}, its only card that can be a commander, as the commander.`);
  if (deck.proxies) lines.push(`${args.binder} holds proxies, so the deck allows them.`);
  lines.push(`Its cards are the deck binder ${args.binder}; swap_deck changes them, and teardown_deck takes it apart.`);
  return lines;
}

async function importDeck(args, { db, user, env, now }) {
  if ([args.url, args.list, args.binder].filter(Boolean).length !== 1) {
    throw new ToolError('Pass one of url, list or binder');
  }
  const context = { db, user, now };
  if (args.binder) {
    const lines = await importBinderDeck(args, context);
    return textResult([...lines, 'Its primer is a placeholder; check_deck shows what the deck still needs.']);
  }
  const source = args.url ? fromArchidekt(await fetchArchidekt(env, user, args.url)) : await fromList(db, args.list);
  const lines =
    args.mode === 'new'
      ? await draftDeckLines(createArgs(args, source), context)
      : await intoDeck(args, withCommanders(source, args.commanders), context);
  if (source.leftOut) lines.push(`Left out ${source.leftOut} sideboard, maybeboard and companion cards.`);
  if (args.mode === 'new') lines.push('Its primer is a placeholder; check_deck shows what the deck still needs.');
  return textResult(lines);
}

export const IMPORT_TOOLS = [
  {
    name: 'import_deck',
    title: 'Import a deck',
    description:
      'Import a deck from a public Archidekt deck link, or from a pasted list (Moxfield, Archidekt, Arena or ManaBox text export; Moxfield links can’t be fetched): as a new draft deck (mode new), or merged into or replacing the cards of an existing one (mode merge or replace). A deck binder (binder), such as a ManaBox deck, becomes a built deck whose cards are that binder; without commanders, its only card that can be a commander is taken. Built decks keep their cards; swap_deck changes them. Commanders come from the list’s Commander section or [Commander] category, or from commanders; sideboard and maybeboard cards are left out. Card names are checked against the card data.',
    schema,
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false, idempotentHint: false },
    handler: importDeck,
  },
];
