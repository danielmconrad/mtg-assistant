// Runs the ingest's SQL against a real (local) D1 database, migrations included, to prove the
// statements are valid there, FTS5 included, and that a second run applies only the changes.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { TABLES } from '../../scripts/ingest/sql.mjs';
import { scryfallCard, tokenCard } from '../fixtures/scryfall.mjs';
import { BUILT, clearCardTables, ingest as runIngest } from './ingest-helper.mjs';

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

const ingest = async (objects) => (await runIngest(objects)).diff;

const count = async (table) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
const search = async (query) =>
  (
    await env.DB.prepare(
      'SELECT c.name FROM cards_fts f JOIN cards c ON c.rowid = f.rowid WHERE cards_fts MATCH ? ORDER BY c.name',
    )
      .bind(query)
      .all()
  ).results.map((row) => row.name);

beforeEach(clearCardTables);

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
