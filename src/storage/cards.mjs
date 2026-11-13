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
         WHERE p.oracle_id IN (SELECT c.oracle_id FROM cards c WHERE ${condition}) ORDER BY p.rowid`,
      )
      .bind(...params)
      .all(),
  ]);
  return joinRows(cards.results, printings.results);
}

function joinRows(cards, printings) {
  const byOracleId = new Map(cards.map((card) => [card.oracle_id, card]));
  return printings.flatMap((printing) => {
    const card = byOracleId.get(printing.oracle_id);
    return card ? [{ ...card, ...printing }] : [];
  });
}

// A card's own fields, decoded once and shared by its printings (src/core never modifies card objects).
function cardFields(row, { formats }) {
  return {
    name: row.name,
    frontName: row.front_name,
    manaCost: row.mana_cost,
    manaValue: row.mana_value,
    typeLine: row.type_line,
    frontType: row.front_type,
    oracleText: row.oracle_text,
    keywords: JSON.parse(row.keywords),
    colorIdentity: identityLetters(row.color_identity),
    producedMana: JSON.parse(row.produced_mana),
    legalities: {
      ...Object.fromEntries(formats.map((format) => [format, 'not_legal'])),
      ...JSON.parse(row.legalities),
    },
    gameChanger: row.game_changer === 1,
    edhrecRank: row.edhrec_rank,
  };
}

// One joined row as a card-model printing (src/core/scryfall.mjs toCard), with every known format
// filled in as not_legal unless the card is legal, restricted or banned there. shared holds the
// card's decoded fields when another printing of it already decoded them.
export function toCardModel(row, context, shared = cardFields(row, context)) {
  const card = {
    id: row.id,
    oracleId: row.oracle_id,
    name: shared.name,
    frontName: shared.frontName,
    set: row.set_code,
    collectorNumber: row.collector_number,
    manaCost: shared.manaCost,
    manaValue: shared.manaValue,
    typeLine: shared.typeLine,
    frontType: shared.frontType,
    flavorName: row.flavor_name,
    oracleText: shared.oracleText,
    keywords: shared.keywords,
    colorIdentity: shared.colorIdentity,
    producedMana: shared.producedMana,
    legalities: row.printing_legalities
      ? { ...shared.legalities, ...JSON.parse(row.printing_legalities) }
      : shared.legalities,
    gameChanger: shared.gameChanger,
    borderColor: row.border_color,
    setType: row.set_type,
    rarity: row.rarity,
    edhrecRank: shared.edhrecRank,
    prices: Object.fromEntries(Object.entries(PRICE_FIELDS).map(([column, field]) => [field, priceText(row[column])])),
    defaultPrinting: row.is_default === 1,
    fetchedAt: context.builtAt,
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

// Owned cards' oracle IDs, for a user bound as the first parameter.
const OWNED_ORACLE_IDS = `SELECT DISTINCT op.oracle_id FROM collection_entries oe JOIN printings op ON op.id = oe.scryfall_id
  WHERE oe.user_id = ?`;
// Playable as src/core/card.mjs isPlayablePrinting judges it: not gold-bordered, not memorabilia.
const PLAYABLE = "(p.border_color IS NOT 'gold' AND p.set_type IS NOT 'memorabilia')";

// The cheapest printing per card in one currency, as upgrades.mjs pricedPrintings and cheapestPrice
// choose: among playable printings when the card has any, else among all, priced above zero.
const cheapestIn = (currency) => `SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY oracle_id ORDER BY ${currency}, id) AS n FROM priced
    WHERE (playable OR NOT any_playable) AND ${currency} > 0
  ) WHERE n = 1`;

// Cards in scope (SQL selecting oracle IDs), each with only the printings src/core reads: Scryfall's
// default, the cheapest in USD and in EUR, and any further printings unions select (SQL selecting
// printing IDs, which may use the scope CTE). Parameters are bound in the order the SQL uses them: the
// scope's, then the unions'.
async function keyPrintingRows(db, { scope, scopeParams = [], unions = [], unionParams = [] }) {
  const printingsSql = `
    WITH scope AS (${scope}),
    priced AS (
      SELECT p.id, p.oracle_id, pr.usd, pr.eur, ${PLAYABLE} AS playable,
             MAX(${PLAYABLE}) OVER (PARTITION BY p.oracle_id) AS any_playable
      FROM printings p JOIN scope s ON s.oracle_id = p.oracle_id LEFT JOIN prices pr ON pr.printing_id = p.id
    ),
    wanted AS (
      SELECT p.id FROM printings p JOIN scope s ON s.oracle_id = p.oracle_id WHERE p.is_default = 1
      UNION ${cheapestIn('usd')}
      UNION ${cheapestIn('eur')}
      ${unions.map((union) => `UNION ${union}`).join('\n      ')}
    )
    SELECT ${PRINTING_COLUMNS} FROM printings p LEFT JOIN prices pr ON pr.printing_id = p.id
    WHERE p.id IN (SELECT id FROM wanted) ORDER BY p.rowid`;
  const [cards, printings] = await Promise.all([
    db
      .prepare(`SELECT ${CARD_COLUMNS} FROM cards c WHERE c.oracle_id IN (${scope})`)
      .bind(...scopeParams)
      .all(),
    db
      .prepare(printingsSql)
      .bind(...scopeParams, ...unionParams)
      .all(),
  ]);
  return joinRows(cards.results, printings.results);
}

// Every card a person has any copy of, protected collections included, with only the printings
// src/core reads: the ones they own, Scryfall's default, the cheapest in USD and in EUR, and, for a
// search by set or rarity, the ones in those sets and rarities. That's a few thousand printings
// instead of every printing of every owned card (about 17,000 for one collection), with the same
// prices, defaults and printing choices.
export function loadOwnedRows(db, userId, { sets = [], rarities = [] } = {}) {
  const marks = (values) => values.map(() => '?').join(', ');
  const matching = [
    sets.length ? `p.set_code IN (${marks(sets)})` : null,
    rarities.length ? `p.rarity IN (${marks(rarities)})` : null,
  ].filter(Boolean);
  return keyPrintingRows(db, {
    scope: OWNED_ORACLE_IDS,
    scopeParams: [userId],
    unions: [
      'SELECT scryfall_id AS id FROM collection_entries WHERE user_id = ? AND scryfall_id IS NOT NULL',
      ...(matching.length
        ? [`SELECT p.id FROM printings p JOIN scope s ON s.oracle_id = p.oracle_id WHERE ${matching.join(' AND ')}`]
        : []),
    ],
    unionParams: [userId, ...sets, ...rarities],
  });
}

// The commanders commander ranking considers (commander_pool.can_command), within an identity when
// given, with the printings it reads: the default and the cheapest.
export const loadCommanderRows = (db, { identityMask } = {}) =>
  keyPrintingRows(db, {
    scope: `SELECT oracle_id FROM commander_pool WHERE can_command = 1${identityMask === undefined ? '' : ' AND (identity & ~?) = 0'}`,
    scopeParams: identityMask === undefined ? [] : [identityMask],
  });

// The precomputed commander-ranking pool, as src/core/commanders.mjs rankCommanders takes it, minus
// commanderIds (the caller's candidates).
export async function loadCommanderPool(db) {
  const [{ results }, meta] = await Promise.all([
    db.prepare('SELECT oracle_id, identity, themes, tribes, is_land FROM commander_pool').all(),
    db.prepare("SELECT value FROM card_data_meta WHERE key = 'creature_types'").first(),
  ]);
  return {
    types: meta ? JSON.parse(meta.value) : [],
    cards: results.map((row) => ({
      oracleId: row.oracle_id,
      identity: row.identity,
      themes: row.themes,
      tribes: new Set(JSON.parse(row.tribes)),
      isLand: row.is_land === 1,
    })),
  };
}

// How many printings Scryfall has of each card, for reports (a request loads only some of them).
export async function printingCounts(db, oracleIds) {
  const counts = new Map();
  for (const chunk of chunks([...new Set(oracleIds)])) {
    const placeholders = chunk.map(() => '?').join(', ');
    const { results } = await db
      .prepare(`SELECT oracle_id, COUNT(*) AS n FROM printings WHERE oracle_id IN (${placeholders}) GROUP BY oracle_id`)
      .bind(...chunk)
      .all();
    for (const row of results) counts.set(row.oracle_id, row.n);
  }
  return counts;
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
  const decoded = new Map();
  for (const row of rows) {
    if (!decoded.has(row.oracle_id)) decoded.set(row.oracle_id, cardFields(row, context));
    cards[row.id] = toCardModel(row, context, decoded.get(row.oracle_id));
  }
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
