// Reads cards from D1 into the in-memory cache mtg-manager's logic works on ({ cards: { printingId: card },
// bulkBuiltAt, refreshedAt }), so src/core runs unchanged. Each request loads only the cards it needs:
// by printing, oracle ID or name, or every card matching a SQL filter, and src/core/card-index.mjs
// indexes that subset as it indexed the whole cache before.
import { cardIndex } from '../core/card-index.mjs';
import { normalizeName } from '../core/card.mjs';

// D1 binds at most 100 parameters per statement.
const MAX_PARAMS = 90;
const COLOR_BITS = [
  ['W', 1],
  ['U', 2],
  ['B', 4],
  ['R', 8],
  ['G', 16],
];
const PRICE_FIELDS = { usd: 'usd', usd_foil: 'usdFoil', usd_etched: 'usdEtched', eur: 'eur' };

export const identityLetters = (mask) => COLOR_BITS.filter(([, bit]) => mask & bit).map(([letter]) => letter);

// Prices are stored as numbers; the card model keeps Scryfall's strings ("1.50"), which upgrades.mjs checks.
const priceText = (value) => (value === null || value === undefined ? null : Number(value).toFixed(2));

const SELECT = `
  SELECT p.id, p.oracle_id, p.name AS printing_name, p.set_code, p.collector_number, p.rarity, p.border_color,
         p.set_type, p.flavor_name, p.is_default, p.overrides, p.printing_legalities,
         c.name, c.front_name, c.mana_cost, c.mana_value, c.type_line, c.front_type, c.oracle_text, c.keywords,
         c.color_identity, c.produced_mana, c.legalities, c.game_changer, c.edhrec_rank,
         pr.usd, pr.usd_foil, pr.usd_etched, pr.eur
  FROM printings p
  JOIN cards c ON c.oracle_id = p.oracle_id
  LEFT JOIN prices pr ON pr.printing_id = p.id`;

// One joined row as a card-model printing (src/core/scryfall.mjs toCard), with every known format
// filled in as not_legal unless the card is legal, restricted or banned there.
export function toCardModel(row, { formats, builtAt }) {
  const legalities = {
    ...Object.fromEntries(formats.map((format) => [format, 'not_legal'])),
    ...JSON.parse(row.legalities),
    ...(row.printing_legalities ? JSON.parse(row.printing_legalities) : {}),
  };
  const card = {
    id: row.id,
    oracleId: row.oracle_id,
    name: row.name,
    frontName: row.front_name,
    set: row.set_code,
    collectorNumber: row.collector_number,
    manaCost: row.mana_cost,
    manaValue: row.mana_value,
    typeLine: row.type_line,
    frontType: row.front_type,
    flavorName: row.flavor_name,
    oracleText: row.oracle_text,
    keywords: JSON.parse(row.keywords),
    colorIdentity: identityLetters(row.color_identity),
    producedMana: JSON.parse(row.produced_mana),
    legalities,
    gameChanger: row.game_changer === 1,
    borderColor: row.border_color,
    setType: row.set_type,
    rarity: row.rarity,
    edhrecRank: row.edhrec_rank,
    prices: Object.fromEntries(Object.entries(PRICE_FIELDS).map(([column, field]) => [field, priceText(row[column])])),
    defaultPrinting: row.is_default === 1,
    fetchedAt: builtAt,
  };
  // A printing that differs from its card (a reversible Secret Lair's name) keeps its own values.
  return row.overrides ? { ...card, ...JSON.parse(row.overrides) } : card;
}

function chunks(values, size = MAX_PARAMS) {
  const result = [];
  for (let start = 0; start < values.length; start += size) result.push(values.slice(start, start + size));
  return result;
}

// What the last ingest recorded: when Scryfall built the data, when it was loaded, and every format.
export async function cardDataMeta(db) {
  const { results } = await db.prepare('SELECT key, value FROM card_data_meta').all();
  const meta = Object.fromEntries(results.map((row) => [row.key, row.value]));
  return {
    builtAt: meta.bulk_built_at ?? null,
    ingestedAt: meta.ingested_at ?? null,
    formats: meta.formats ? JSON.parse(meta.formats) : null,
    cardCount: meta.card_count ? Number(meta.card_count) : 0,
  };
}

async function selectRows(db, where, values, maxParams = MAX_PARAMS) {
  const rows = [];
  for (const chunk of chunks(values, maxParams)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const { results } = await db
      .prepare(`${SELECT} WHERE ${where(placeholders)}`)
      .bind(...chunk)
      .all();
    rows.push(...results);
  }
  return rows;
}

async function oracleIdsWhere(db, sql, values, { paramsPerValue = 1, maxParams = MAX_PARAMS } = {}) {
  const found = [];
  for (const chunk of chunks(values, Math.floor(maxParams / paramsPerValue))) {
    const { results } = await db
      .prepare(sql(chunk))
      .bind(...chunk.flat())
      .all();
    found.push(...results.map((row) => row.oracle_id));
  }
  return found;
}

// Every printing of the given cards: by Scryfall printing ID, by oracle ID, by exact name (either
// face, as card-index.mjs matches), or by set and collector number ({ set, collectorNumber }). Whole
// cards are loaded, every printing, since prices and printing choice look across printings. maxParams
// is D1's binding limit; a caller that inlines values (the migration script) can pass more.
export async function loadCardRows(
  db,
  { printingIds = [], oracleIds = [], names = [], printings = [] } = {},
  { maxParams = MAX_PARAMS } = {},
) {
  const marks = (chunk) => chunk.map(() => '?').join(', ');
  const keys = [...new Set(names.map(normalizeName))];
  const pairs = [
    ...new Map(
      printings.map(({ set, collectorNumber }) => {
        const pair = [String(set).toLowerCase(), String(collectorNumber)];
        return [pair.join('|'), pair];
      }),
    ).values(),
  ];
  const lookups = [
    [(chunk) => `SELECT oracle_id FROM printings WHERE id IN (${marks(chunk)})`, [...new Set(printingIds)], 1],
    [(chunk) => `SELECT oracle_id FROM cards WHERE name_key IN (${marks(chunk)})`, keys, 1],
    [(chunk) => `SELECT oracle_id FROM cards WHERE front_name_key IN (${marks(chunk)})`, keys, 1],
    [
      // A row-value list, not an OR chain: D1 caps expression depth at 100, which ORs count toward.
      (chunk) =>
        `SELECT oracle_id FROM printings WHERE (set_code, collector_number) IN (VALUES ${chunk.map(() => '(?, ?)').join(', ')})`,
      pairs,
      2,
    ],
  ];
  const wanted = new Set(oracleIds);
  for (const [sql, values, paramsPerValue] of lookups) {
    for (const oracleId of await oracleIdsWhere(db, sql, values, { paramsPerValue, maxParams })) wanted.add(oracleId);
  }
  return selectRows(db, (placeholders) => `p.oracle_id IN (${placeholders})`, [...wanted], maxParams);
}

// Every printing of every card matching a filter on cards (alias c), such as
// { sql: 'c.legal_commander = 1 AND (c.color_identity & ~?) = 0', params: [24] }.
export async function loadMatchingRows(db, { sql, params = [] }) {
  const { results } = await db
    .prepare(`${SELECT} WHERE p.oracle_id IN (SELECT c.oracle_id FROM cards c WHERE ${sql})`)
    .bind(...params)
    .all();
  return results;
}

// The formats every card is judged in, from the ingest, or from the loaded rows when an older ingest
// didn't record them.
function knownFormats(meta, rows) {
  if (meta.formats) return meta.formats;
  const formats = new Set();
  for (const row of rows) for (const format of Object.keys(JSON.parse(row.legalities))) formats.add(format);
  return [...formats].sort();
}

// The in-memory cache and index for a set of rows.
export async function cardIndexFor(db, rows) {
  const meta = await cardDataMeta(db);
  const context = { formats: knownFormats(meta, rows), builtAt: meta.builtAt ?? new Date(0).toISOString() };
  const cards = {};
  for (const row of rows) cards[row.id] = toCardModel(row, context);
  const cache = { version: 7, cards, bulkBuiltAt: meta.builtAt, refreshedAt: meta.ingestedAt };
  return { cache, index: cardIndex(cache), meta };
}
