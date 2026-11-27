// Runs an ingest into the test D1 the way scripts/ingest-scryfall.mjs does: diff against the hashes
// already there, then apply the statements in order.
import { env } from 'cloudflare:test';
import { withCardKingdom } from '../../scripts/ingest/cardkingdom.mjs';
import { buildRows, diffRows } from '../../scripts/ingest/rows.mjs';
import { TABLES, ingestStatements } from '../../scripts/ingest/sql.mjs';
import { toCard } from '../../src/core/scryfall.mjs';

// Built a day ago and loaded just now, so prices never pass PRICE_MAX_AGE_DAYS and tools never warn
// that the card data is stale, whatever day the tests run.
export const BUILT = new Date(Date.now() - 86_400_000).toISOString();
export const INGESTED = new Date().toISOString();

async function currentHashes() {
  const current = {};
  for (const [table, { key }] of Object.entries(TABLES)) {
    const { results } = await env.DB.prepare(`SELECT ${key} AS k, hash AS h FROM ${table}`).all();
    current[table] = new Map(results.map((row) => [row.k, row.h]));
  }
  return current;
}

// defaults are Scryfall objects for each card's default printing; others are further printings,
// rulings Scryfall ruling objects, and cardKingdom Card Kingdom's prices ({ printingId: { price,
// inStock } }, as cardKingdomPrices reads them).
export async function ingest(defaults, others = [], rulings = [], cardKingdom = new Map()) {
  const printings = withCardKingdom(
    [
      ...defaults.map((object) => toCard(object, BUILT, { defaultPrinting: true })),
      ...others.map((object) => toCard(object, BUILT)),
    ],
    cardKingdom,
  );
  const rows = await buildRows(printings, rulings);
  const current = await currentHashes();
  const diff = Object.fromEntries(
    Object.entries(TABLES).map(([table, { key }]) => [table, diffRows(rows[table], key, current[table])]),
  );
  const meta = {
    bulk_built_at: BUILT,
    ingested_at: INGESTED,
    card_count: rows.cards.length,
    formats: JSON.stringify(rows.formats),
    creature_types: JSON.stringify(rows.creatureTypes),
  };
  for (const statement of ingestStatements(diff, meta)) await env.DB.prepare(statement).run();
  return { diff, rows };
}

export const clearCardTables = () =>
  env.DB.batch(
    ['cards', 'printings', 'prices', 'cards_fts', 'card_data_meta', 'commander_pool', 'rulings'].map((table) =>
      env.DB.prepare(`DELETE FROM ${table}`),
    ),
  );
