// find_combos: the combos Commander Spellbook knows among a deck's cards (or a list of cards), and the
// ones a single card away, each with whether the person owns that card. Commander Spellbook is asked
// through the outbound allowlist with the cards' names and nothing else, and its answer is checked
// for shape before anything is read from it.
import { z } from 'zod';
import { holdingsNote, ownedCounts, protectedHoldings } from '../../core/collection.mjs';
import { deckEntries } from '../../core/deck.mjs';
import { OutboundRefused, boundedJson, outboundFetch } from '../../outbound.mjs';
import { nameSuggester } from '../../storage/cards.mjs';
import { loadCollections } from '../../storage/collections.mjs';
import { loadDeck } from '../../storage/decks.mjs';
import { slug } from './decks.mjs';
import { ToolError, personalIndex, staleDataWarning, textResult } from './shared.mjs';

const SPELLBOOK_URL = 'https://backend.commanderspellbook.com/find-my-combos';
const COMBO_PAGE = 'https://commanderspellbook.com/combo/';
// Commander Spellbook's bracket tags (its API schema's BracketTagEnum).
const BRACKET_TAGS = {
  R: 'Ruthless',
  S: 'Spicy',
  P: 'Powerful',
  O: 'Oddball',
  C: 'Core',
  E: 'Exhibition',
  B: 'Banned',
};
// The most cards Commander Spellbook takes in a request's mainboard and commanders.
const MAX_MAIN = 600;
const MAX_COMMANDERS = 12;
const DEFAULT_LIMIT = 20;
// The result lists find_combos reads; the others (changing commanders) don't apply to a fixed deck.
const INCLUDED = 'included';
const ALMOST = 'almostIncluded';
const OTHER_COLORS = 'almostIncludedByAddingColors';

const isText = (value) => typeof value === 'string';
const optionalText = (value) => value === undefined || value === null || isText(value);
const listOf = (value, check) => Array.isArray(value) && value.every(check);
const OPTIONAL_TEXT = [
  'identity',
  'bracketTag',
  'description',
  'manaNeeded',
  'easyPrerequisites',
  'notablePrerequisites',
];

function isVariant(variant) {
  return (
    isText(variant?.id) &&
    listOf(variant.uses, (use) => isText(use?.card?.name) && optionalText(use.card.oracleId)) &&
    listOf(variant.produces ?? [], (product) => isText(product?.feature?.name)) &&
    listOf(variant.requires ?? [], (requirement) => isText(requirement?.template?.name)) &&
    OPTIONAL_TEXT.every((field) => optionalText(variant[field])) &&
    Number.isFinite(variant.popularity ?? 0)
  );
}

// Commander Spellbook's results, refused unless every list find_combos reads holds well-formed combos.
function spellbookShape(body) {
  const results = body?.results;
  const ok =
    results &&
    typeof results === 'object' &&
    [INCLUDED, ALMOST].every((list) => listOf(results[list], isVariant)) &&
    listOf(results[OTHER_COLORS] ?? [], isVariant);
  if (!ok) throw new ToolError('Commander Spellbook sent combos in a shape this server doesn’t recognize');
  return results;
}

function toCombo(variant) {
  return {
    id: variant.id,
    cards: variant.uses.map(({ card }) => ({ name: card.name, oracleId: card.oracleId ?? null })),
    requires: (variant.requires ?? []).map(({ template }) => template.name),
    produces: (variant.produces ?? []).map(({ feature }) => feature.name),
    identity: variant.identity || 'C',
    bracket: BRACKET_TAGS[variant.bracketTag] ?? null,
    manaNeeded: variant.manaNeeded || null,
    prerequisites: [variant.easyPrerequisites, variant.notablePrerequisites].filter((text) => text?.trim()),
    steps: variant.description?.trim() || null,
    popularity: variant.popularity ?? 0,
  };
}

async function askSpellbook(env, user, { commanders, main }) {
  const { success } = await env.RL_COMBOS.limit({ key: user.id });
  if (!success) throw new ToolError('Too many combo searches just now; try again in a minute');
  const card = (name) => ({ card: name, quantity: 1 });
  let response;
  try {
    response = await outboundFetch(SPELLBOOK_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ commanders: commanders.map(card), main: main.map(card) }),
    });
  } catch (error) {
    if (error instanceof OutboundRefused) throw new ToolError(`Commander Spellbook: ${error.message}`);
    throw new ToolError('Commander Spellbook could not be reached; try again later');
  }
  if (!response.ok) throw new ToolError(`Commander Spellbook answered ${response.status}; try again later`);
  try {
    return spellbookShape(await boundedJson(response));
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(`Commander Spellbook: ${error.message}`);
  }
}

// The cards to ask about, as the card data spells them: a deck's commanders and mainboard, any cards
// named (added to the deck's), and commanders for a list without a deck. Unknown names are refused
// with suggestions.
async function cardsToAsk(db, user, args) {
  const deck = args.slug ? await loadDeck(db, user.id, args.slug) : null;
  if (args.slug && !deck) throw new ToolError(`No deck named ${args.slug}; list_decks shows yours`);
  const given = [...(args.commanders ?? []), ...(args.cards ?? [])];
  const names = [...(deck ? deckEntries(deck).map((entry) => entry.name) : []), ...given];
  const { index, meta } = await personalIndex(db, user.id, { names });
  const unknown = given.filter((name) => !index.lookup({ name }).card);
  if (unknown.length) {
    const suggest = await nameSuggester(db);
    throw new ToolError(
      unknown
        .map((name) => {
          const suggestions = suggest(name);
          return `No card named ${name}${suggestions.length ? `; did you mean ${suggestions.join(', ')}?` : ''}`;
        })
        .join('\n'),
    );
  }
  const canonical = (list = []) => list.map((name) => index.lookup({ name }).card.name);
  const label = deck ? `${args.slug}${args.cards ? ' with those cards' : ''}` : 'those cards';
  return {
    label,
    index,
    meta,
    commanders: deck ? deck.commanders.map((entry) => entry.name) : canonical(args.commanders),
    main: [...(deck ? deck.mainboard.map((entry) => entry.name) : []), ...canonical(args.cards)],
  };
}

const unique = (names) => [...new Set(names)];

function comboLine(combo, { prefix = '' } = {}) {
  const cards = combo.cards
    .map((card) => card.name)
    .concat(combo.requires.map((name) => `a ${name}`))
    .join(' + ');
  const tags = [combo.identity, combo.bracket].filter(Boolean).join(', ');
  const produces = combo.produces.length ? ` → ${combo.produces.join('; ')}` : '';
  return `- ${prefix}${cards}${produces} [${tags}] ${COMBO_PAGE}${combo.id}/`;
}

function detailLines(combo, withSteps) {
  if (!withSteps) return [];
  return [
    ...(combo.manaNeeded ? [`    Mana: ${combo.manaNeeded}`] : []),
    ...combo.prerequisites.map((text) => `    Needs: ${text.replace(/\s*\n\s*/g, ' ')}`),
    ...(combo.steps ? combo.steps.split('\n').map((step) => `    ${step.trim()}`) : []),
  ];
}

function section(title, combos, toLine, { limit, withSteps }) {
  if (!combos.length) return [];
  const shown = combos.slice(0, limit);
  return [
    title,
    ...shown.flatMap((combo) => [toLine(combo), ...detailLines(combo, withSteps)]),
    ...(combos.length > shown.length ? [`  …and ${combos.length - shown.length} more; raise limit to see them`] : []),
  ];
}

async function findCombos(args, { db, env, user, now }) {
  if (!args.slug && !args.cards) throw new ToolError('Pass a deck’s slug, cards, or both');
  if (args.slug && args.commanders) {
    throw new ToolError('A deck has its own commanders; pass commanders only with cards');
  }
  const asked = await cardsToAsk(db, user, args);
  const commanders = unique(asked.commanders);
  const main = unique(asked.main).filter((name) => !commanders.includes(name));
  if (commanders.length > MAX_COMMANDERS || main.length > MAX_MAIN) {
    throw new ToolError(`Commander Spellbook takes at most ${MAX_MAIN} cards and ${MAX_COMMANDERS} commanders`);
  }
  const [results, collections] = await Promise.all([
    askSpellbook(env, user, { commanders, main }),
    loadCollections(db, user.id),
  ]);
  const owned = ownedCounts(collections.available, asked.index).counts;
  const held = protectedHoldings(collections.protected, asked.index);
  const inList = new Set(
    [...commanders, ...main].flatMap((name) => {
      const { card } = asked.index.lookup({ name });
      return card ? [card.oracleId, card.name.toLowerCase()] : [name.toLowerCase()];
    }),
  );
  const isIn = (card) => (card.oracleId && inList.has(card.oracleId)) || inList.has(card.name.toLowerCase());

  const byPopularity = (first, second) => second.popularity - first.popularity;
  const included = results[INCLUDED].map(toCombo).sort(byPopularity);
  // A near combo's missing card, and whether the person has a copy free for the deck (or only protected).
  const near = results[ALMOST].map(toCombo).flatMap((combo) => {
    const missing = combo.cards.filter((card) => !isIn(card));
    if (missing.length !== 1) return [];
    const [card] = missing;
    const available = card.oracleId ? (owned.get(card.oracleId) ?? 0) : 0;
    const protectedIn = card.oracleId ? (held.get(card.oracleId) ?? []) : [];
    return [{ ...combo, missing: card, available, protectedIn }];
  });
  // Copies free for the deck first, then protected ones, then unowned.
  const ownership = (combo) => Math.sign(combo.available) * 2 + Math.sign(combo.protectedIn.length);
  near.sort((first, second) => ownership(second) - ownership(first) || byPopularity(first, second));
  const otherColors = (results[OTHER_COLORS] ?? []).length;

  const nearLine = (combo) => {
    const copies = [
      combo.available ? `${combo.available} available` : null,
      combo.protectedIn.length ? `${holdingsNote(combo.protectedIn)} (protected)` : null,
    ].filter(Boolean);
    return comboLine(combo, { prefix: `Add ${combo.missing.name} (${copies.join('; ') || 'not owned'}): ` });
  };
  const options = { limit: args.limit, withSteps: args.steps };
  const lines = [
    `Commander Spellbook: ${included.length} combos in ${asked.label}, ${near.length} one card away within its colors${otherColors ? `, ${otherColors} more needing other colors` : ''}.`,
    ...section('Combos:', included, (combo) => comboLine(combo), options),
    ...(args.near ? section('One card away:', near, nearLine, options) : []),
  ];
  if (included.length || near.length) {
    lines.push(
      'Ruthless, Spicy, Powerful and the like are Commander Spellbook’s bracket tags; "a …" is any card of that kind.',
    );
  }
  return textResult(lines, [staleDataWarning(asked.meta, now)].filter(Boolean));
}

const cardName = z.string().min(1).max(200);

export const COMBO_TOOLS = [
  {
    name: 'find_combos',
    title: 'Find combos',
    description:
      "Find the combos Commander Spellbook knows among a deck's cards (slug), a list of cards, or a deck plus cards (such as its planned adds), and the ones a single card away, with whether the person owns that card. Each combo shows its cards, what it produces (infinite mana, win the game...), its colors and Commander Spellbook's bracket tag; steps: true adds how it works. Sends only the card names to Commander Spellbook. Use it for bracket checks and reviews rather than recalling combos.",
    schema: z
      .object({
        slug: slug.optional(),
        cards: z
          .array(cardName)
          .min(1)
          .max(100)
          .optional()
          .describe('Card names to check, alone or added to the deck’s'),
        commanders: z.array(cardName).max(4).optional().describe('Commanders for a list of cards'),
        near: z.boolean().default(true).describe('Include combos one card away'),
        steps: z.boolean().default(false).describe('Include each combo’s mana, prerequisites and steps'),
        limit: z.number().int().min(1).max(100).default(DEFAULT_LIMIT).describe('Combos shown per section'),
      })
      .strict(),
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true, destructiveHint: false },
    handler: findCombos,
  },
];
