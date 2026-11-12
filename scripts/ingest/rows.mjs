// Turns card-model printings (src/core/scryfall.mjs toCard) into the rows of migrations/0002_cards.sql,
// each with a hash of its values, and works out which rows an ingest must write or delete. Web APIs
// only, so the workerd tests can load it too.
import { normalizeName } from '../../src/core/card.mjs';

// Fields that differ between printings of one card; every other field is the card's.
const PRINTING_FIELDS = new Set([
  'id',
  'oracleId',
  'set',
  'collectorNumber',
  'flavorName',
  'borderColor',
  'setType',
  'rarity',
  'prices',
  'defaultPrinting',
  'fetchedAt',
]);
// Fields that change over time, taken from the card's base printing.
const CURRENT_FIELDS = new Set(['legalities', 'gameChanger', 'edhrecRank']);
// Formats Scryfall judges per printing rather than per card.
const PRINTING_FORMATS = new Set(['oldschool']);
const NOT_LEGAL = 'not_legal';
const PLAYS = new Set(['legal', 'restricted']);
const COLOR_BITS = { W: 1, U: 2, B: 4, R: 8, G: 16 };

export const identityMask = (colors) => colors.reduce((mask, color) => mask | (COLOR_BITS[color] ?? 0), 0);

const sortedJson = (object) =>
  JSON.stringify(Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : 1))));

function compactLegalities(legalities, keep) {
  return Object.fromEntries(
    Object.entries(legalities).filter(([format, status]) => status !== NOT_LEGAL && keep(format)),
  );
}

function price(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function withHash(row) {
  const bytes = new TextEncoder().encode(JSON.stringify(row));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  // 64 bits is plenty to notice a changed row.
  const hash = [...digest.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return { ...row, hash };
}

function cardRow(card) {
  const legalities = compactLegalities(card.legalities, (format) => !PRINTING_FORMATS.has(format));
  return {
    oracle_id: card.oracleId,
    name: card.name,
    name_key: normalizeName(card.name),
    front_name: card.frontName,
    front_name_key: normalizeName(card.frontName),
    mana_cost: card.manaCost,
    mana_value: card.manaValue,
    type_line: card.typeLine,
    front_type: card.frontType,
    oracle_text: card.oracleText,
    keywords: JSON.stringify(card.keywords),
    color_identity: identityMask(card.colorIdentity),
    produced_mana: JSON.stringify(card.producedMana),
    legalities: sortedJson(legalities),
    legal_commander: PLAYS.has(card.legalities.commander) ? 1 : 0,
    playable: Object.values(card.legalities).some((status) => PLAYS.has(status)) ? 1 : 0,
    game_changer: card.gameChanger ? 1 : 0,
    edhrec_rank: card.edhrecRank,
  };
}

// The rules fields where a printing differs from its card's base printing.
function overrides(printing, base) {
  const differing = Object.entries(printing).filter(
    ([field, value]) =>
      !PRINTING_FIELDS.has(field) &&
      !CURRENT_FIELDS.has(field) &&
      JSON.stringify(value) !== JSON.stringify(base[field]),
  );
  return differing.length ? sortedJson(Object.fromEntries(differing)) : null;
}

function printingRow(printing, base) {
  const printingLegalities = compactLegalities(printing.legalities, (format) => PRINTING_FORMATS.has(format));
  return {
    id: printing.id,
    oracle_id: printing.oracleId,
    name: printing.name,
    set_code: printing.set,
    collector_number: printing.collectorNumber,
    rarity: printing.rarity,
    border_color: printing.borderColor,
    set_type: printing.setType,
    flavor_name: printing.flavorName,
    is_default: printing.defaultPrinting ? 1 : 0,
    overrides: overrides(printing, base),
    printing_legalities: Object.keys(printingLegalities).length ? sortedJson(printingLegalities) : null,
  };
}

const priceRow = (printing) => ({
  printing_id: printing.id,
  usd: price(printing.prices.usd),
  usd_foil: price(printing.prices.usdFoil),
  usd_etched: price(printing.prices.usdEtched),
  eur: price(printing.prices.eur),
});

// Byte order, as D1 sorts text, so output is stable.
const byKey = (key) => (first, second) => (first[key] < second[key] ? -1 : Number(first[key] > second[key]));

// Keeps one printing per key, preferring Scryfall's default printing, else the first one seen.
function preferDefault(printings, keyOf) {
  const kept = new Map();
  for (const printing of printings) {
    const seen = kept.get(keyOf(printing));
    if (!seen || (printing.defaultPrinting && !seen.defaultPrinting)) kept.set(keyOf(printing), printing);
  }
  return kept;
}

// Rows for every card, printing and price, sorted by key so output is stable. A card's base printing is
// Scryfall's default printing for its name, else the first one seen.
export async function buildRows(printings) {
  const valid = [...printings].filter((printing) => printing?.id && printing.oracleId && printing.name);
  const unique = preferDefault(valid, (printing) => printing.id);
  const base = preferDefault(unique.values(), (printing) => printing.oracleId);
  const cards = await Promise.all([...base.values()].map((card) => withHash(cardRow(card))));
  const all = [...unique.values()];
  const printingRows = await Promise.all(
    all.map((printing) => withHash(printingRow(printing, base.get(printing.oracleId)))),
  );
  const prices = await Promise.all(all.map((printing) => withHash(priceRow(printing))));
  return {
    cards: cards.sort(byKey('oracle_id')),
    printings: printingRows.sort(byKey('id')),
    prices: prices.sort(byKey('printing_id')),
  };
}

// The rows to write (new or changed) and the keys to delete, against current { key: hash }.
export function diffRows(rows, key, current) {
  const upserts = rows.filter((row) => current.get(row[key]) !== row.hash);
  const keep = new Set(rows.map((row) => row[key]));
  const deletes = [...current.keys()].filter((existing) => !keep.has(existing)).sort();
  return { upserts, deletes };
}
