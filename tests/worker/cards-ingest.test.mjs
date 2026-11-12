// Runs the ingest's SQL against a real (local) D1 database, migrations included, to prove the
// statements are valid there, FTS5 included, and that a second run applies only the changes.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildRows, diffRows } from '../../scripts/ingest/rows.mjs';
import { TABLES, ingestStatements } from '../../scripts/ingest/sql.mjs';
import { toCard } from '../../src/core/scryfall.mjs';
import { scryfallCard, tokenCard } from '../fixtures/scryfall.mjs';

const BUILT = '2026-11-12T10:06:21.099Z';
const reanimate = scryfallCard('Reanimate', {
  type_line: 'Sorcery',
  mana_cost: '{B}',
  cmc: 1,
  color_identity: ['B'],
  oracle_text:
    'Put target creature card from a graveyard onto the battlefield under your control. You lose life equal to its mana value.',
});
const urzasSaga = scryfallCard("Urza's Saga", {
  type_line: 'Enchantment Land — Urza’s Saga',
  oracle_text: 'Urza’s Saga is a land.',
});
const llanowar = scryfallCard('Llanowar Elves', {
  type_line: 'Creature — Elf Druid',
  color_identity: ['G'],
  oracle_text: '{T}: Add {G}.',
});

async function currentHashes() {
  const current = {};
  for (const [table, { key }] of Object.entries(TABLES)) {
    const { results } = await env.DB.prepare(`SELECT ${key} AS k, hash AS h FROM ${table}`).all();
    current[table] = new Map(results.map((row) => [row.k, row.h]));
  }
  return current;
}

// One ingest, as the script runs it: diff against what's there, then apply the statements in order.
async function ingest(objects) {
  const rows = await buildRows(objects.map((object) => toCard(object, BUILT, { defaultPrinting: true })));
  const current = await currentHashes();
  const diff = Object.fromEntries(
    Object.entries(TABLES).map(([table, { key }]) => [table, diffRows(rows[table], key, current[table])]),
  );
  const statements = ingestStatements(diff, { bulk_built_at: BUILT, card_count: rows.cards.length });
  for (const statement of statements) await env.DB.prepare(statement).run();
  return diff;
}

const count = async (table) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
const search = async (query) =>
  (
    await env.DB.prepare(
      'SELECT c.name FROM cards_fts f JOIN cards c ON c.rowid = f.rowid WHERE cards_fts MATCH ? ORDER BY c.name',
    )
      .bind(query)
      .all()
  ).results.map((row) => row.name);

beforeEach(async () => {
  await env.DB.batch(
    ['cards', 'printings', 'prices', 'cards_fts', 'card_data_meta'].map((table) =>
      env.DB.prepare(`DELETE FROM ${table}`),
    ),
  );
});

describe('ingest SQL in D1', () => {
  it('loads cards, printings, prices, the search index and meta', async () => {
    await ingest([reanimate, urzasSaga, llanowar, tokenCard('Goblin')]);
    expect(await count('cards')).toBe(4);
    expect(await count('printings')).toBe(4);
    expect(await count('prices')).toBe(4);
    expect(await search('graveyard')).toEqual(['Reanimate']);
    expect(await search('elf')).toEqual(['Llanowar Elves']);
    const saga = await env.DB.prepare('SELECT name, oracle_text FROM cards WHERE name_key = ?')
      .bind("urza's saga")
      .first();
    expect(saga).toEqual({ name: "Urza's Saga", oracle_text: 'Urza’s Saga is a land.' });
    const meta = await env.DB.prepare("SELECT value FROM card_data_meta WHERE key = 'bulk_built_at'").first();
    expect(meta.value).toBe(BUILT);
  });

  it('finds cards that fit a color identity with the bitmask', async () => {
    await ingest([reanimate, urzasSaga, llanowar]);
    const golgari = 4 | 16;
    const { results } = await env.DB.prepare('SELECT name FROM cards WHERE (color_identity & ~?) = 0 ORDER BY name')
      .bind(golgari)
      .all();
    expect(results.map((row) => row.name)).toEqual(['Llanowar Elves', 'Reanimate', "Urza's Saga"]);
    const mono = await env.DB.prepare('SELECT name FROM cards WHERE (color_identity & ~?) = 0 ORDER BY name')
      .bind(16)
      .all();
    expect(mono.results.map((row) => row.name)).toEqual(['Llanowar Elves', "Urza's Saga"]);
  });

  it('writes only what changed on the next run, and keeps the index in step', async () => {
    await ingest([reanimate, urzasSaga, llanowar]);
    const rowidBefore = (await env.DB.prepare("SELECT rowid FROM cards WHERE name = 'Reanimate'").first()).rowid;

    const errata = { ...reanimate, oracle_text: `${reanimate.oracle_text} (errata: exile it instead)` };
    const repriced = { ...llanowar, prices: { ...llanowar.prices, usd: '0.35' } };
    const diff = await ingest([errata, repriced]);

    expect(diff.cards.upserts.map((row) => row.name)).toEqual(['Reanimate']);
    expect(diff.cards.deletes).toEqual(['urza-s-saga-oracle']);
    expect(diff.printings.upserts).toEqual([]);
    expect(diff.prices.upserts.map((row) => row.printing_id)).toEqual(['llanowar-elves-print']);
    expect(await count('cards')).toBe(2);
    expect(await count('cards_fts')).toBe(2);
    expect(await search('errata')).toEqual(['Reanimate']);
    expect(await search('saga')).toEqual([]);
    expect((await env.DB.prepare("SELECT rowid FROM cards WHERE name = 'Reanimate'").first()).rowid).toBe(rowidBefore);
    expect(
      (await env.DB.prepare("SELECT usd FROM prices WHERE printing_id = 'llanowar-elves-print'").first()).usd,
    ).toBe(0.35);

    const unchanged = await ingest([errata, repriced]);
    for (const table of Object.keys(TABLES)) {
      expect(unchanged[table].upserts, table).toEqual([]);
      expect(unchanged[table].deletes, table).toEqual([]);
    }
  });

  it('stores hostile text as text', async () => {
    const hostile = scryfallCard("Bobby'); DROP TABLE cards; --", {
      oracle_text: "It's a trap'); DELETE FROM prices; --",
    });
    await ingest([hostile, reanimate]);
    expect(await count('cards')).toBe(2);
    expect(await count('prices')).toBe(2);
    const row = await env.DB.prepare('SELECT name, oracle_text FROM cards WHERE oracle_id = ?')
      .bind(`${hostile.oracle_id}`)
      .first();
    expect(row).toEqual({ name: hostile.name, oracle_text: hostile.oracle_text });
  });
});
