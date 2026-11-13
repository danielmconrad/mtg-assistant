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

// Cards and their printings are fetched separately and joined here: a joined query would repeat each
// card's rules text once per printing, several times the data for a collection's worth of cards.
const CARD_COLUMNS = `c.oracle_id, c.name, c.front_name, c.mana_cost, c.mana_value, c.type_line, c.front_type,
  c.oracle_text, c.keywords, c.color_identity, c.produced_mana, c.legalities, c.game_changer, c.edhrec_rank`;
const PRINTING_COLUMNS = `p.id, p.oracle_id, p.name AS printing_name, p.set_code, p.collector_number, p.rarity,
  p.border_color, p.set_type, p.flavor_name, p.is_default, p.overrides, p.printing_legalities,
  pr.usd, pr.usd_foil, pr.usd_etched, pr.eur`;

// Every printing of every card matching condition (SQL on cards c), as one row per printing with its
// card's fields, in the shape toCardModel reads.
async function rowsWhere(db, condition, params = []) {
  const [cards, printings] = await Promise.all([
    db
      .prepare(`SELECT ${CARD_COLUMNS} FROM cards c WHERE ${condition}`)
      .bind(...params)
      .all(),
    db
      .prepare(
        `SELECT ${PRINTING_COLUMNS} FROM printings p LEFT JOIN prices pr ON pr.printing_id = p.id
         WHERE p.oracle_id IN (SELECT c.oracle_id FROM cards c WHERE ${condition})`,
      )
      .bind(...params)
      .all(),
  ]);
  const byOracleId = new Map(cards.results.map((card) => [card.oracle_id, card]));
  return printings.results.flatMap((printing) => {
    const card = byOracleId.get(printing.oracle_id);
    return card ? [{ ...card, ...printing }] : [];
  });
}

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
    printingCount: meta.printing_count ? Number(meta.printing_count) : 0,
  };
}

async function rowsForOracleIds(db, oracleIds, maxParams = MAX_PARAMS) {
  const rows = [];
  for (const chunk of chunks(oracleIds, maxParams)) {
    rows.push(...(await rowsWhere(db, `c.oracle_id IN (${chunk.map(() => '?').join(', ')})`, chunk)));
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
  return rowsForOracleIds(db, [...wanted], maxParams);
}

// Every printing of every card matching a filter on cards (alias c), such as
// { sql: 'c.legal_commander = 1 AND (c.color_identity & ~?) = 0', params: [24] }.
export const loadMatchingRows = (db, { sql, params = [] }) => rowsWhere(db, sql, params);

// Every printing of every card a person has any copy of, protected collections included: what
// ownership counts, searches of their collection and printing choices need.
export const loadOwnedRows = (db, userId) =>
  rowsWhere(
    db,
    `c.oracle_id IN (SELECT p.oracle_id FROM collection_entries e JOIN printings p ON p.id = e.scryfall_id
      WHERE e.user_id = ?)`,
    [userId],
  );

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

// Suggestions for a misspelled name from every card's name, as card-index.mjs suggests them. A
// request's index holds only the cards it loaded, so it can't suggest from the rest; this loads just
// the names (about 40,000), and only when a lookup misses.
export async function nameSuggester(db) {
  const { results } = await db.prepare('SELECT oracle_id, name, front_name, playable FROM cards').all();
  const cards = {};
  for (const row of results) {
    cards[row.oracle_id] = {
      id: row.oracle_id,
      oracleId: row.oracle_id,
      name: row.name,
      frontName: row.front_name,
      set: '',
      collectorNumber: '',
      legalities: row.playable ? { any: 'legal' } : {},
      defaultPrinting: true,
    };
  }
  const index = cardIndex({ cards, bulkBuiltAt: 'names only' });
  return (name) => index.suggestNames(name);
}
