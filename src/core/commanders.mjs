// collection:commanders: every commander in the card cache, owned or not, ranked by how much of the
// collection feeds the themes its rules text cares about.
import { canBeCommander, isLand } from './card.mjs';
import {
  THEMES,
  commanderThemeIndexes,
  commanderTribes,
  creatureTypeVocabulary,
  tribesFed,
} from './commander-themes.mjs';
import { ownedCounts, protectedHoldings } from './collection.mjs';
import { edhrecFit } from './edhrec.mjs';
import { parseIdentity } from './search.mjs';
import { cheapestPrice } from './upgrades.mjs';

// The fewest on-theme cards a commander needs to be listed: about a third of a Commander deck's
// nonland slots, so the theme can carry a deck.
export const DEFAULT_MIN_CARDS = 30;

const COLORS = 'WUBRG';
const identityMask = (colors) =>
  [...COLORS].reduce((mask, color, bit) => (colors.includes(color) ? mask | (1 << bit) : mask), 0);
const IDENTITY_MASKS = Array.from({ length: 1 << COLORS.length }, (_, mask) => mask);
const CHANGELING = '*';

// Every Commander-legal nonland card in the cache, bucketed by color identity: the pool an average
// collection is drawn from. Each records the themes it feeds as a bit per THEMES entry, the creature
// types it has, makes or names, and whether an available collection holds it.
function cardProfiles(index, owned) {
  const legal = index
    .playableOracleIds()
    .map((oracleId) => index.printingsOf(oracleId)[0])
    .filter((card) => card.legalities.commander === 'legal');
  const vocabulary = creatureTypeVocabulary(legal);
  const buckets = IDENTITY_MASKS.map(() => []);
  for (const card of legal.filter((candidate) => !isLand(candidate))) {
    const themes = THEMES.reduce((bits, theme, position) => (theme.feeds(card) ? bits | (1 << position) : bits), 0);
    const profile = { card, themes, tribes: tribesFed(card, vocabulary), owned: owned.counts.has(card.oracleId) };
    buckets[identityMask(card.colorIdentity)].push(profile);
  }
  return { legal, vocabulary, buckets };
}

// A commander's themes and tribes as tests on a card profile.
function commanderFeatures(commander, vocabulary) {
  const themes = commanderThemeIndexes(commander).map((position) => ({
    name: THEMES[position].name,
    fed: (profile) => (profile.themes & (1 << position)) !== 0,
  }));
  const tribes = commanderTribes(commander, vocabulary).map((type) => ({
    name: type,
    fed: (profile) => profile.tribes.has(type) || profile.tribes.has(CHANGELING),
  }));
  return [...themes, ...tribes];
}

const emptyCount = () => ({ owned: 0, all: 0 });
const add = (count, profile) => {
  count.all += 1;
  if (profile.owned) count.owned += 1;
};

// Owned and baseline counts for the pool within an identity, each feature, and the cards that feed any.
function countFeatures(buckets, mask, features) {
  const pool = emptyCount();
  const perFeature = features.map(emptyCount);
  const fed = emptyCount();
  for (const bucket of IDENTITY_MASKS.filter((other) => (other & mask) === other).map((other) => buckets[other])) {
    for (const profile of bucket) {
      add(pool, profile);
      const fedBy = features.map((feature) => feature.fed(profile));
      fedBy.forEach((isFed, position) => isFed && add(perFeature[position], profile));
      if (fedBy.some(Boolean)) add(fed, profile);
    }
  }
  return { pool, perFeature, fed };
}

// The counts without the commander itself, which feeds its own themes but can't be in its deck twice.
function withoutSelf(counts, features, self) {
  if (!self) return counts;
  const minus = (count, isFed) =>
    isFed ? { owned: count.owned - Number(self.owned), all: count.all - 1 } : { ...count };
  const fedBy = features.map((feature) => feature.fed(self));
  return {
    pool: minus(counts.pool, true),
    perFeature: counts.perFeature.map((count, position) => minus(count, fedBy[position])),
    fed: minus(counts.fed, fedBy.some(Boolean)),
  };
}

// How the collection compares with an average collection of the same size in the commander's colors:
// expected is how many cards would feed the theme if the owned cards were drawn at random from every
// Commander-legal card, and lift is owned over expected.
function fitFromCounts({ pool, perFeature, fed }, features) {
  const share = pool.all ? pool.owned / pool.all : 0;
  const compare = ({ owned, all }) => {
    const expected = all * share;
    return { cards: owned, expected, lift: expected ? owned / expected : null };
  };
  return {
    pool: pool.owned,
    themes: features.map(({ name }, position) => ({ name, ...compare(perFeature[position]) })),
    ...compare(fed),
  };
}

// Commanders sharing an identity, themes and tribes share counts, so each combination is counted once.
function fitScorer(profiles) {
  const memo = new Map();
  const selfProfiles = new Map(profiles.buckets.flat().map((profile) => [profile.card.oracleId, profile]));
  return (commander) => {
    const features = commanderFeatures(commander, profiles.vocabulary);
    if (!features.length) return null;
    const mask = identityMask(commander.colorIdentity);
    const key = `${mask}|${features.map(({ name }) => name).join('|')}`;
    if (!memo.has(key)) memo.set(key, countFeatures(profiles.buckets, mask, features));
    return fitFromCounts(withoutSelf(memo.get(key), features, selfProfiles.get(commander.oracleId)), features);
  };
}

// The deck folders each commander leads, by oracle ID.
function decksLed(decks, index) {
  const led = new Map();
  for (const { slug, deck } of decks) {
    for (const entry of deck.commanders ?? []) {
      const { card } = index.lookup(entry);
      if (card) led.set(card.oracleId, [...(led.get(card.oracleId) ?? []), slug]);
    }
  }
  return led;
}

const nullsLast = (first, second) => {
  if (first === null || second === null) return (first === null) - (second === null);
  return second - first;
};
const SORTS = {
  lift: (first, second) => nullsLast(first.lift, second.lift) || second.cards - first.cards,
  cards: (first, second) => second.cards - first.cards || nullsLast(first.lift, second.lift),
  edhrec: (first, second) =>
    nullsLast(first.edhrec?.synergyShare ?? null, second.edhrec?.synergyShare ?? null) ||
    nullsLast(first.lift, second.lift),
};
export const COMMANDER_SORT_CHOICES = Object.keys(SORTS);
const OWNERSHIP_CHOICES = ['owned', 'unowned'];

// Translates collection:commanders and edhrec:refresh options into rankCommanders filters.
export function commanderFilters(options) {
  if (options.owned && options.unowned) throw new Error('Use --owned or --unowned, not both');
  return {
    identity: options.identity && parseIdentity(options.identity),
    ownership: OWNERSHIP_CHOICES.find((choice) => options[choice]),
    name: options.name && new RegExp(options.name, 'i'),
    theme: options.theme && new RegExp(options.theme, 'i'),
    maxPriceUsd: options['max-price'],
    minCards: options['min-cards'] ?? DEFAULT_MIN_CARDS,
    sort: options.sort ?? 'lift',
  };
}

// Filters on the commander card, before it's scored.
const COMMANDER_PREDICATES = [
  ({ card }, { identity }) => !identity || card.colorIdentity.every((color) => identity.has(color)),
  ({ available }, { ownership }) => !ownership || (ownership === 'owned') === available > 0,
  ({ card }, { name }) => !name || name.test(card.name),
  ({ priceUsd }, { maxPriceUsd }) => maxPriceUsd === undefined || priceUsd === null || priceUsd <= maxPriceUsd,
];

// Every Commander-legal commander the filters keep, scored against the available collections, with
// EDHREC's view where edhrec (the cached pages, by commander name) has one. Results below minCards
// on-theme cards, or without a theme the THEMES tests recognise, are counted rather than listed.
export function rankCommanders(collections, index, filters, { edhrec = {}, decks = [] } = {}) {
  const owned = ownedCounts(collections.available, index);
  const holdings = protectedHoldings(collections.protected, index);
  const profiles = cardProfiles(index, owned);
  const scoreFit = fitScorer(profiles);
  const led = decksLed(decks, index);
  const candidates = profiles.legal
    .filter(canBeCommander)
    .map((card) => ({
      card,
      available: owned.counts.get(card.oracleId) ?? 0,
      protectedIn: holdings.get(card.oracleId) ?? [],
      protected: (holdings.get(card.oracleId) ?? []).reduce((sum, { copies }) => sum + copies, 0),
      priceUsd: cheapestPrice(index, card),
      edhrecRank: card.edhrecRank ?? null,
      leads: led.get(card.oracleId) ?? [],
    }))
    .filter((candidate) => COMMANDER_PREDICATES.every((predicate) => predicate(candidate, filters)));
  let unthemed = 0;
  let belowMinimum = 0;
  const results = [];
  for (const candidate of candidates) {
    const fit = scoreFit(candidate.card);
    const themes = fit?.themes.filter(({ name }) => !filters.theme || filters.theme.test(name));
    if (!fit || !themes.length) {
      unthemed += 1;
    } else if (fit.cards < filters.minCards) {
      belowMinimum += 1;
    } else {
      const page = edhrec[candidate.card.name];
      results.push({ ...candidate, ...fit, edhrec: page ? edhrecFit(page, index, owned) : null });
    }
  }
  results.sort(SORTS[filters.sort] ?? SORTS.lift);
  return { results, considered: candidates.length, unthemed, belowMinimum, unresolvedRows: owned.unresolvedRows };
}
