// import_deck: a draft deck from a public Archidekt deck or a pasted list. Archidekt has a public JSON API;
// Moxfield refuses requests that don't come from a browser, so its decks come in as their text export.
// Either way the cards are checked against the card data and the deck is saved as create_deck saves it.
import { z } from 'zod';
import { normalizeName } from '../../core/card.mjs';
import { OutboundRefused, boundedJson, outboundFetch } from '../../outbound.mjs';
import { resolvedRows } from './collection-writes.mjs';
import { createDeckLines, createSchema } from './deck-writes.mjs';
import { slug } from './decks.mjs';
import { ToolError, textResult } from './shared.mjs';

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
    slug: slug
      .optional()
      .describe('The new deck’s slug; from the Archidekt deck’s name when left out, required for a list'),
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

// create_deck's arguments for the imported cards.
function createArgs(args, source) {
  const deck = withCommanders(source, args.commanders);
  const deckSlug = args.slug ?? (source.name && slugFrom(source.name));
  if (!deckSlug) throw new ToolError('Pass slug: the new deck’s name as lowercase words joined by hyphens');
  if (!deck.mainboard.length && !deck.commanders.length) throw new ToolError('The deck has no cards');
  const parsed = createSchema.safeParse({
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

async function importDeck(args, { db, user, env, now }) {
  if (Boolean(args.url) === Boolean(args.list)) throw new ToolError('Pass either url or list');
  const source = args.url ? fromArchidekt(await fetchArchidekt(env, user, args.url)) : await fromList(db, args.list);
  const lines = await createDeckLines(createArgs(args, source), { db, user, now });
  if (source.leftOut) lines.push(`Left out ${source.leftOut} sideboard, maybeboard and companion cards.`);
  lines.push('Its primer is a placeholder; check_deck shows what the deck still needs.');
  return textResult(lines);
}

export const IMPORT_TOOLS = [
  {
    name: 'import_deck',
    title: 'Import a deck',
    description:
      'Create a draft deck from a public Archidekt deck link, or from a pasted list (Moxfield, Archidekt or Arena text export; Moxfield links can’t be fetched). Commanders come from the list’s Commander section or [Commander] category, or from commanders; sideboard and maybeboard cards are left out. Card names are checked against the card data.',
    schema,
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false, idempotentHint: false },
    handler: importDeck,
  },
];
