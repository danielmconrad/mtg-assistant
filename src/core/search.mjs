import { canBeCommander, creatureTypes, identityLabel, isLand } from './card.mjs';
import { ownedCounts, protectedHoldings } from './collection.mjs';
import { deckEntries, resolveEntries } from './deck.mjs';
import { isCommanderFormat } from './formats.mjs';
import { priceCap } from './rules.mjs';
import { cheapestPrice } from './upgrades.mjs';

const COLORS = 'WUBRG';
const IDENTITY_PATTERN = /^[WUBRGC]+$/i;
const NUMBER_PATTERN = /^\d+(\.\d+)?$/;

// Letters from WUBRG; C alone means colorless only.
export function parseIdentity(text) {
  if (!IDENTITY_PATTERN.test(text)) {
    throw new Error(`Color identity "${text}" must use W, U, B, R, G, or C for colorless`);
  }
  return new Set([...text.toUpperCase()].filter((letter) => COLORS.includes(letter)));
}

function parseNumber(value, flag) {
  if (value === undefined) return undefined;
  if (!NUMBER_PATTERN.test(value)) throw new Error(`${flag} must be a number`);
  return Number(value);
}

const caseInsensitive = (source) => new RegExp(source, 'i');

// Rough rules-text tests for the deck roles a search can find; wincon, synergy and land depend on the
// deck. They overcount (draw also matches cards that make an opponent draw, removal includes
// counterspells), so read the list before quoting a count.
export const ROLE_PATTERNS = {
  ramp: /\badd \{|\badds? (?:one|two|three|x) mana\b|\badd [^.]*mana of any|search(?:es)? (?:your|their) library for [^.]*\bland\b|\bcreate[^.]*\btreasure\b|put[^.]*\bland cards?[^.]*onto the battlefield/i,
  draw: /\bdraws? (?:a|an|one|two|three|four|five|six|seven|x|that many|cards equal to|an additional)\b|\binvestigate\b|\bcreate[^.]*\bclue\b/i,
  removal:
    /\b(?:destroy|exile) (?:target|another target|up to (?:one|two|three) target)|\bcounter target\b|deals? (?:\d+|x|that much) damage to (?:any target|any one target|target creature|target planeswalker)|\bfights? (?:target|another target|up to one target)|target creature[^.]*gets -(?:\d+|x)\/-(?:\d+|x)|return target (?:nonland )?permanent[^.]* to its owner's hand/i,
  wipe: /\b(?:destroy|exile) (?:all|each)\b|deals? (?:\d+|x) damage to each (?:creature|other creature)|all (?:other )?creatures get -|each (?:player|opponent) sacrifices[^.]*creatures?|return all [^.]*to (?:their|its) owners?'? hands?/i,
  protection:
    /(?:creatures? you control|permanents? you control|target (?:creature|permanent) you control|equipped creature|enchanted creature|your commander)[^.]*\b(?:hexproof|indestructible|shroud|protection from|phases? out|ward)\b|\byou have (?:hexproof|shroud)\b|\bphases? out\b/i,
};
export const ROLE_CHOICES = Object.keys(ROLE_PATTERNS);

// A card's roles by rules text; lands count as land, and a spell matching none as other.
export function textRoles(card) {
  if (isLand(card)) return ['land'];
  const roles = ROLE_CHOICES.filter((role) => ROLE_PATTERNS[role].test(card.oracleText));
  return roles.length ? roles : ['other'];
}

function parseRoles(roles = []) {
  for (const role of roles) {
    if (!Object.hasOwn(ROLE_PATTERNS, role)) throw new Error(`--role must be one of: ${ROLE_CHOICES.join(', ')}`);
  }
  return roles.map((role) => ROLE_PATTERNS[role]);
}

// Scryfall's rarities, from its rarity field.
export const RARITY_CHOICES = ['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus'];

// Set codes, repeated or comma-separated, in Scryfall's lower case.
const parseSets = (sets = []) =>
  sets.length ? new Set(sets.flatMap((value) => value.split(',')).map((code) => code.trim().toLowerCase())) : undefined;

function parseRarities(rarities = []) {
  for (const rarity of rarities) {
    if (!RARITY_CHOICES.includes(rarity)) throw new Error(`--rarity must be one of: ${RARITY_CHOICES.join(', ')}`);
  }
  return rarities.length ? new Set(rarities) : undefined;
}

function commanderFilters(name, index, legalIn) {
  const { card, problem } = index.lookup({ name });
  if (problem) throw new Error(problem);
  return { identity: new Set(card.colorIdentity), legalIn: legalIn ?? 'commander' };
}

// Translates collection:search command-line options into filters for searchCollection.
export function searchFilters(options, index) {
  if (options.commander && options.identity) throw new Error('Use --commander or --identity, not both');
  const filters = {
    name: options.name && caseInsensitive(options.name),
    types: (options.type ?? []).map(caseInsensitive),
    texts: [...(options.text ?? []).map(caseInsensitive), ...parseRoles(options.role)],
    identity: options.identity && parseIdentity(options.identity),
    legalIn: options.legal,
    minManaValue: parseNumber(options['min-mv'], '--min-mv'),
    maxManaValue: parseNumber(options['max-mv'], '--max-mv'),
    commandersOnly: Boolean(options.commanders),
    nonlandOnly: Boolean(options.nonland),
    gameChangersOnly: Boolean(options['game-changers']),
    includeProtectedOnly: Boolean(options['include-protected']),
    allowProxies: Boolean(options.proxies),
    unowned: Boolean(options.unowned),
    allCards: Boolean(options['all-cards']),
    sets: parseSets(options.set),
    rarities: parseRarities(options.rarity),
    maxPriceUsd: parseNumber(options['max-price'], '--max-price'),
    minCopies: parseNumber(options['min-copies'], '--min-copies'),
  };
  if (filters.unowned && filters.minCopies) throw new Error('Use --unowned or --min-copies, not both');
  if (filters.unowned && filters.allCards) throw new Error('Use --unowned or --all-cards, not both');
  if (!options.commander) return filters;
  return { ...filters, ...commanderFilters(options.commander, index, filters.legalIn) };
}

// One predicate per filter; an unset filter matches everything.
const FILTER_PREDICATES = [
  (card, { identity }) => !identity || card.colorIdentity.every((color) => identity.has(color)),
  (card, { commandersOnly }) => !commandersOnly || canBeCommander(card),
  (card, { nonlandOnly }) => !nonlandOnly || !isLand(card),
  (card, { gameChangersOnly }) => !gameChangersOnly || card.gameChanger,
  (card, { legalIn }) => !legalIn || card.legalities[legalIn] === 'legal',
  (card, { minManaValue }) => minManaValue === undefined || card.manaValue >= minManaValue,
  (card, { maxManaValue }) => maxManaValue === undefined || card.manaValue <= maxManaValue,
  (card, { name }) => !name || name.test(card.name),
  (card, { types = [] }) => types.every((pattern) => pattern.test(card.typeLine)),
  (card, { texts = [] }) => texts.every((pattern) => pattern.test(card.oracleText)),
];

const matches = (card, filters) => FILTER_PREDICATES.every((predicate) => predicate(card, filters));

const byManaValueThenName = (first, second) =>
  first.card.manaValue - second.card.manaValue || first.card.name.localeCompare(second.card.name);

// The cheapest USD quote among a card's playable printings, whatever its age, and its EDHREC rank.
// They only steer attention, so a stale price is fine here; deck:upgrades prices purchases.
const cardValue = (index, card) => ({ priceUsd: cheapestPrice(index, card), edhrecRank: card.edhrecRank ?? null });

// Unknown values sort last. EDHREC ranks ascend (1 is the most played), prices descend.
const nullsLast = (first, second, compare) => {
  if (first === null || second === null) return (first === null) - (second === null);
  return compare(first, second);
};
const SORTS = {
  mv: byManaValueThenName,
  edhrec: (first, second) =>
    nullsLast(first.edhrecRank, second.edhrecRank, (a, b) => a - b) ||
    nullsLast(first.priceUsd, second.priceUsd, (a, b) => b - a) ||
    byManaValueThenName(first, second),
  price: (first, second) =>
    nullsLast(first.priceUsd, second.priceUsd, (a, b) => b - a) ||
    nullsLast(first.edhrecRank, second.edhrecRank, (a, b) => a - b) ||
    byManaValueThenName(first, second),
};
export const SORT_CHOICES = Object.keys(SORTS);

export function sortResults(results, by = 'mv') {
  if (!Object.hasOwn(SORTS, by)) throw new Error(`--sort must be one of: ${SORT_CHOICES.join(', ')}`);
  return results.toSorted(SORTS[by]);
}

// Filters on a result's copies and value, after the card filters.
const RESULT_PREDICATES = [
  ({ available }, { unowned }) => !unowned || available === 0,
  ({ available }, { minCopies }) => minCopies === undefined || available >= minCopies,
  ({ priceUsd }, { maxPriceUsd }) => maxPriceUsd === undefined || priceUsd === null || priceUsd <= maxPriceUsd,
];

// The cards a search looks at: owned ones (protected-only ones too with includeProtectedOnly), or with
// unowned or allCards every playable card in the cache.
function searchedOracleIds(index, owned, holdings, filters) {
  if (filters.unowned || filters.allCards) return new Set(index.playableOracleIds());
  const oracleIds = new Set(owned.counts.keys());
  if (filters.includeProtectedOnly) for (const oracleId of holdings.keys()) oracleIds.add(oracleId);
  return oracleIds;
}

// The printing a result stands for: the first (Scryfall's default first) in one of the sets and of one
// of the rarities, or undefined when none is. Without either filter, the card's first printing.
const matchingPrinting = (printings, { sets, rarities }) =>
  printings.find((printing) => (!sets || sets.has(printing.set)) && (!rarities || rarities.has(printing.rarity)));

// One result per card (oracle ID): copies in available collections, and protected copies by collection.
// With unowned, the cards without an available copy, from the whole cache; with allCards, every card.
// Copies count every printing, so with sets they aren't only copies from those sets.
export function searchCollection(collections, index, filters = {}) {
  const policy = { allowProxies: filters.allowProxies };
  const owned = ownedCounts(collections.available, index, policy);
  const protectedOwned = ownedCounts(collections.protected, index, policy);
  const holdings = protectedHoldings(collections.protected, index, policy);
  const oracleIds = searchedOracleIds(index, owned, holdings, filters);
  const results = [...oracleIds]
    .map((oracleId) => {
      const printings = index.printingsOf(oracleId);
      return {
        card: printings[0],
        printing: matchingPrinting(printings, filters),
        available: owned.counts.get(oracleId) ?? 0,
        protected: protectedOwned.counts.get(oracleId) ?? 0,
        protectedIn: holdings.get(oracleId) ?? [],
      };
    })
    .filter(({ card, printing }) => printing && matches(card, filters))
    .map((result) => ({ ...result, ...cardValue(index, result.card) }))
    .filter((result) => RESULT_PREDICATES.every((predicate) => predicate(result, filters)))
    .sort(byManaValueThenName);
  const unresolvedRows = owned.unresolvedRows + (filters.includeProtectedOnly ? protectedOwned.unresolvedRows : 0);
  return { results, unresolvedRows };
}

export const countResults = (results) => ({
  cards: results.length,
  copies: results.reduce((sum, result) => sum + result.available, 0),
});

const GROUP_KEYS = {
  identity: (card) => [identityLabel(card)],
  'creature-type': creatureTypes,
  role: textRoles,
  // The matched printing's, so with --set it's the rarity in that set.
  rarity: (card, { printing }) => [printing?.rarity ?? 'unknown'],
};
export const GROUP_BY_CHOICES = Object.keys(GROUP_KEYS);

// Distinct cards and available copies per group, largest first. A card counts once in each of its groups.
export function groupResults(results, by) {
  if (!Object.hasOwn(GROUP_KEYS, by)) throw new Error(`--group-by must be one of: ${GROUP_BY_CHOICES.join(', ')}`);
  const groups = new Map();
  for (const result of results) {
    const { card, available } = result;
    for (const key of GROUP_KEYS[by](card, result)) {
      const group = groups.get(key) ?? { key, cards: 0, copies: 0 };
      group.cards += 1;
      group.copies += available;
      groups.set(key, group);
    }
  }
  return [...groups.values()].sort(
    (first, second) => second.cards - first.cards || first.key.localeCompare(second.key),
  );
}

// Available cards a deck could play but doesn't: in its commanders' color identity and legal for a
// commander format, not in the commanders or mainboard, and within its price cap (overCap counts the
// cards left out for costing more; unknown prices stay in). Each keeps the reason from the deck's
// considered list, if any. Lands are left out unless lands is set.
export function deckCandidates(
  deck,
  collections,
  index,
  { texts = [], types = [], roles = [], lands = false, sort = 'edhrec' } = {},
) {
  const commanderRules = isCommanderFormat(deck.format);
  const commanders = deck.commanders.map((entry) => index.lookup(entry).card);
  if (commanderRules && commanders.some((card) => !card)) {
    throw new Error('Every commander must be in the card cache; run scryfall:refresh -- --missing');
  }
  const filters = {
    texts: [...texts, ...parseRoles(roles)],
    types,
    nonlandOnly: !lands,
    ...(commanderRules
      ? { identity: new Set(commanders.flatMap((card) => card.colorIdentity)), legalIn: 'commander' }
      : {}),
  };
  const inDeck = resolveEntries(deckEntries(deck), index).tallies;
  const reasons = new Map(
    (deck.considered ?? []).flatMap(({ name, reason }) => {
      const { card } = index.lookup({ name });
      return card ? [[card.oracleId, reason]] : [];
    }),
  );
  const { results, unresolvedRows } = searchCollection(collections, index, filters);
  const cap = priceCap(deck);
  const overCapOf = (card) => {
    const price = cap && cheapestPrice(index, card, cap.currency);
    return Boolean(price) && price > cap.amount;
  };
  const leftOut = results.filter(({ card, available }) => available && !inDeck.has(card.oracleId));
  const candidates = leftOut
    .filter(({ card }) => !overCapOf(card))
    .map((result) => ({ ...result, considered: reasons.get(result.card.oracleId) }));
  return { results: sortResults(candidates, sort), unresolvedRows, overCap: leftOut.length - candidates.length };
}
