import { isLand } from './card.mjs';
import { ROLE_VOCABULARY, deckEntries, resolveEntries, roleLabels } from './deck.mjs';
import { FORMATS, isCommanderFormat } from './formats.mjs';
import { bracketFloor } from './rules.mjs';

export const CARD_TYPES = [
  'Creature',
  'Artifact',
  'Enchantment',
  'Planeswalker',
  'Battle',
  'Instant',
  'Sorcery',
  'Land',
];
export const MANA_SYMBOLS = ['W', 'U', 'B', 'R', 'G', 'C'];
export const CURVE_TOP_BUCKET = 7;
export const CHEAP_MANA_VALUE = 2;
const CHEAP_ROLES = ['ramp', 'draw'];

// Frank Karsten's regression on winning decklists ("How Many Lands Do You Need in Your Deck? An Updated
// Analysis", ChannelFireball). Each cheap ramp or draw spell replaces about 0.28 lands; the Commander
// version scales the 60-card fit to the library size and credits the free mulligan and the commander.
// For Custom Dollar Brawl's 60 cards the same adjustment is an extrapolation, not one of Karsten's fits.
export function suggestedLands({ format, commanderCount, averageManaValue, cheapRampAndDraw }) {
  const cheapCredit = 0.28 * cheapRampAndDraw;
  const deckSize = isCommanderFormat(format) ? FORMATS[format].size : undefined;
  if (deckSize === undefined) return 19.59 + 1.9 * averageManaValue - cheapCredit;
  const scale = (deckSize - commanderCount) / 60;
  return scale * (19.59 + 1.9 * averageManaValue + 0.27 * commanderCount) - cheapCredit - 1.35;
}

// The Command Zone's template (episode 379) for Commander, used when a deck sets no role_targets. Lands
// are left to Karsten's suggestion.
export const COMMAND_ZONE_TARGETS = {
  ramp: { min: 10, max: 12 },
  draw: { min: 10 },
  removal: { min: 10, max: 12 },
  wipe: { min: 3, max: 4 },
};

function targetStatus(count, min, max) {
  if (count < min) return 'under';
  return max !== undefined && count > max ? 'over' : 'within';
}

// Each target with the deck's count and whether it's under, within or over, from the deck's own
// role_targets or, for Commander, the Command Zone template.
function roleTargets(deck, roles) {
  const source = deck.role_targets ? 'role_targets' : deck.format === 'commander' && 'Command Zone template';
  if (!source) return { source: null, targets: [] };
  const targets = Object.entries(deck.role_targets ?? COMMAND_ZONE_TARGETS).map(([role, { min, max }]) => {
    const count = roles.get(role) ?? 0;
    return { role, count, min, max: max ?? null, status: targetStatus(count, min, max) };
  });
  return { source, targets };
}

// The chance a hand of size drawn from size total cards holds exactly hits of the wanted ones.
function hypergeometric(total, wanted, drawn, hits) {
  const choose = (n, k) => {
    if (k < 0 || k > n) return 0;
    let result = 1;
    for (let step = 1; step <= k; step += 1) result = (result * (n - k + step)) / step;
    return result;
  };
  return (choose(wanted, hits) * choose(total - wanted, drawn - hits)) / choose(total, drawn);
}

export const OPENING_HAND = 7;

// Odds for an opening hand from the mainboard: its land count, and drawing at least one ramp card.
function openingHand(cards, lands, ramp) {
  if (cards < OPENING_HAND) return null;
  const landOdds = (from, to) => {
    let sum = 0;
    for (let hits = from; hits <= to; hits += 1) sum += hypergeometric(cards, lands, OPENING_HAND, hits);
    return sum;
  };
  return {
    fewLands: landOdds(0, 1),
    keepableLands: landOdds(2, 4),
    manyLands: landOdds(5, OPENING_HAND),
    someRamp: 1 - hypergeometric(cards, ramp, OPENING_HAND, 0),
  };
}

const increment = (counts, key, amount) => counts.set(key, (counts.get(key) ?? 0) + amount);

// Pips per color in a mana cost; hybrid and Phyrexian symbols count toward each color they name.
function pips(manaCost) {
  const counts = new Map();
  for (const [, symbol] of manaCost.matchAll(/\{([^}]+)\}/g)) {
    for (const color of MANA_SYMBOLS) if (symbol.split('/').includes(color)) increment(counts, color, 1);
  }
  return counts;
}

// Nonland mainboard cards with role ramp or draw at mana value 2 or less: Karsten's "cheap" spells.
function countCheapRampAndDraw(entries, index) {
  let count = 0;
  for (const entry of entries) {
    const { card } = index.lookup(entry);
    const isCheapSpell = card && !isLand(card) && card.manaValue <= CHEAP_MANA_VALUE;
    if (isCheapSpell && roleLabels(entry).some((role) => CHEAP_ROLES.includes(role))) count += entry.quantity;
  }
  return count;
}

// The colors a land can make for this deck: in a commander format, only the commanders' color identity
// and colorless, so Command Tower in a green-white deck counts for green and white alone. null means any.
function producibleColors(deck, index) {
  if (!isCommanderFormat(deck.format)) return null;
  const commanders = deck.commanders.map((entry) => index.lookup(entry).card);
  if (!commanders.length || commanders.some((card) => !card)) return null;
  return new Set(['C', ...commanders.flatMap((card) => card.colorIdentity)]);
}

// A commander deck's brackets: the lowest its cards allow, commanders included, with what raises it, and
// the judged and agreed ones from deck.yaml; null for casual decks.
const bracketOf = (deck, index) =>
  isCommanderFormat(deck.format)
    ? {
        ...bracketFloor(resolveEntries(deckEntries(deck), index).tallies),
        playsLike: deck.plays_like_bracket ?? null,
        target: deck.target_bracket ?? null,
      }
    : null;

const landColors = (card, producible) =>
  producible ? card.producedMana.filter((color) => producible.has(color)) : card.producedMana;

// Mainboard shape only; commanders sit in the command zone and are reported separately.
export function deckStats(deck, index) {
  const { tallies, problems } = resolveEntries(deck.mainboard, index);
  const producible = producibleColors(deck, index);
  const stats = {
    cards: 0,
    lands: 0,
    nonlandManaValue: 0,
    curve: new Map(),
    types: new Map(),
    pips: new Map(),
    landSources: new Map(),
    roles: new Map(),
    problems,
  };
  for (const { card, quantity } of tallies.values()) {
    stats.cards += quantity;
    for (const type of CARD_TYPES) if (card.frontType.includes(type)) increment(stats.types, type, quantity);
    if (isLand(card)) {
      stats.lands += quantity;
      for (const color of landColors(card, producible)) increment(stats.landSources, color, quantity);
      continue;
    }
    stats.nonlandManaValue += card.manaValue * quantity;
    increment(stats.curve, Math.min(Math.floor(card.manaValue), CURVE_TOP_BUCKET), quantity);
    for (const [color, count] of pips(card.manaCost)) increment(stats.pips, color, count * quantity);
  }
  for (const entry of deck.mainboard) {
    for (const role of roleLabels(entry)) increment(stats.roles, role, entry.quantity);
  }
  stats.cheapRampAndDraw = countCheapRampAndDraw(deck.mainboard, index);
  const nonlandCards = stats.cards - stats.lands;
  stats.averageManaValue = nonlandCards ? stats.nonlandManaValue / nonlandCards : 0;
  stats.suggestedLands = nonlandCards
    ? suggestedLands({ ...stats, format: deck.format, commanderCount: deck.commanders.length })
    : null;
  stats.roleTargets = roleTargets(deck, stats.roles);
  stats.bracket = bracketOf(deck, index);
  stats.openingHand = openingHand(stats.cards, stats.lands, stats.roles.get('ramp') ?? 0);
  return stats;
}

const NO_ROLE = 'no role';
const byManaValueThenName = (first, second) =>
  first.card.manaValue - second.card.manaValue || first.card.name.localeCompare(second.card.name);

// deck:show: the commanders, and the mainboard grouped by each entry's first role: the role vocabulary
// in order, then other labels, then entries without a role. An applied deck's upgradesIn are marked as
// upgrades. With role, only entries that have it are listed.
export function deckListing(deck, index, { role } = {}) {
  const problems = [];
  const item = (entry, upgrade) => {
    const { card, problem } = index.lookup(entry);
    if (problem) problems.push(problem);
    return card && { card, quantity: entry.quantity, roles: roleLabels(entry), upgrade };
  };
  const commanders = deck.commanders.map((entry) => item(entry, false)).filter(Boolean);
  const entries = [
    ...deck.mainboard.map((entry) => item(entry, false)),
    ...(deck.upgradesIn ?? []).map((entry) => item(entry, true)),
  ].filter((listed) => listed && (!role || listed.roles.includes(role)));
  const groupOf = (listed) => listed.roles[0] ?? NO_ROLE;
  const order = new Set([...ROLE_VOCABULARY, ...entries.map(groupOf).filter((key) => key !== NO_ROLE), NO_ROLE]);
  const groups = [...order]
    .map((key) => ({ role: key, items: entries.filter((listed) => groupOf(listed) === key).sort(byManaValueThenName) }))
    .filter(({ items }) => items.length);
  return { commanders, groups, problems };
}
