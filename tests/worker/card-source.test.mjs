// The D1 card source rebuilds mtg-manager's card model exactly, so src/core sees the same cards it
// saw from the local cache.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkDeck } from '../../src/core/rules.mjs';
import { toCard } from '../../src/core/scryfall.mjs';
import { cardIndexFor, identityLetters, loadCardRows, loadMatchingRows } from '../../src/storage/cards.mjs';
import { inlineParams } from '../../scripts/migrate/plan.mjs';
import { scryfallCard } from '../fixtures/scryfall.mjs';
import { BUILT, INGESTED, clearCardTables, ingest } from './ingest-helper.mjs';

const forest = scryfallCard('Forest', {
  type_line: 'Basic Land — Forest',
  color_identity: ['G'],
  produced_mana: ['G'],
  prices: { usd: '0.20', usd_foil: null, usd_etched: null, eur: null },
});
const leader = scryfallCard('Ayula, Queen Among Bears', {
  type_line: 'Legendary Creature — Bear',
  mana_cost: '{1}{G}',
  cmc: 2,
  color_identity: ['G'],
  oracle_text: 'Whenever another Bear you control enters, choose one —',
  edhrec_rank: 2500,
});
const delver = scryfallCard('Delver of Secrets // Insectile Aberration', {
  type_line: undefined,
  oracle_text: undefined,
  mana_cost: undefined,
  cmc: 1,
  color_identity: ['U'],
  card_faces: [
    { name: 'Delver of Secrets', type_line: 'Creature — Human Wizard', oracle_text: 'Transform it.', mana_cost: '{U}' },
    { name: 'Insectile Aberration', type_line: 'Creature — Human Insect', oracle_text: 'Flying' },
  ],
});
const promoForest = { ...forest, id: 'forest-promo', set: 'prm', collector_number: '250', prices: { usd: '1.5' } };
const reversible = { ...leader, id: 'ayula-reversible', name: 'Ayula // Ayula', set: 'sld', collector_number: '7' };
const lea = {
  ...forest,
  id: 'forest-lea',
  set: 'lea',
  collector_number: '294',
  legalities: { ...forest.legalities, oldschool: 'legal' },
};

// What mtg-manager's cache held for a Scryfall object: toCard, every known format filled in, prices
// with two decimals, and the bulk build time.
function expectedCard(object, { defaultPrinting = false } = {}) {
  const card = toCard(object, BUILT, { defaultPrinting });
  const formats = ['commander', 'oldschool', 'standard'];
  return {
    ...card,
    legalities: { ...Object.fromEntries(formats.map((format) => [format, 'not_legal'])), ...card.legalities },
    prices: Object.fromEntries(
      Object.entries(card.prices).map(([field, value]) => [field, value === null ? null : Number(value).toFixed(2)]),
    ),
  };
}

beforeEach(async () => {
  await clearCardTables();
  await ingest([forest, leader, delver], [promoForest, reversible, lea]);
});

describe('identityLetters', () => {
  it('turns the bitmask back into WUBRG letters', () => {
    expect(identityLetters(0)).toEqual([]);
    expect(identityLetters(31)).toEqual(['W', 'U', 'B', 'R', 'G']);
    expect(identityLetters(24)).toEqual(['R', 'G']);
  });
});

describe('loadCardRows and cardIndexFor', () => {
  it('rebuilds each printing exactly as mtg-manager cached it', async () => {
    const rows = await loadCardRows(env.DB, { names: ['forest', 'Ayula, Queen Among Bears', 'Delver of Secrets'] });
    const { cache } = await cardIndexFor(env.DB, rows);
    expect(Object.keys(cache.cards).sort()).toEqual(
      [
        'ayula-queen-among-bears-print',
        'ayula-reversible',
        'delver-of-secrets-insectile-aberration-print',
        'forest-lea',
        'forest-print',
        'forest-promo',
      ].sort(),
    );
    expect(cache.cards['forest-print']).toEqual(expectedCard(forest, { defaultPrinting: true }));
    expect(cache.cards['forest-promo']).toEqual(expectedCard(promoForest));
    expect(cache.cards['delver-of-secrets-insectile-aberration-print']).toEqual(
      expectedCard(delver, { defaultPrinting: true }),
    );
    expect(cache.cards['ayula-reversible']).toEqual(expectedCard(reversible));
    expect(cache.cards['forest-lea'].legalities.oldschool).toBe('legal');
    expect(cache.cards['forest-print'].legalities.oldschool).toBe('not_legal');
    expect(cache).toMatchObject({ bulkBuiltAt: BUILT, refreshedAt: INGESTED });
  });

  it('loads whole cards by printing ID, oracle ID, or set and collector number', async () => {
    const byPrinting = await loadCardRows(env.DB, { printingIds: ['forest-promo'] });
    expect(byPrinting.map((row) => row.id).sort()).toEqual(['forest-lea', 'forest-print', 'forest-promo']);
    const byOracle = await loadCardRows(env.DB, { oracleIds: ['ayula-queen-among-bears-oracle'] });
    expect(byOracle).toHaveLength(2);
    const bySetNumber = await loadCardRows(env.DB, {
      printings: [
        { set: 'PRM', collectorNumber: '250' },
        { set: 'zzz', collectorNumber: '1' },
      ],
    });
    expect(new Set(bySetNumber.map((row) => row.oracle_id))).toEqual(new Set(['forest-oracle']));
    expect(await loadCardRows(env.DB, { names: ['No Such Card'] })).toEqual([]);
  });

  it('looks up many set and collector numbers at once, within D1’s expression depth limit', async () => {
    const printings = [
      ...Array.from({ length: 200 }, (_, index) => ({ set: 'zzz', collectorNumber: String(index) })),
      { set: 'prm', collectorNumber: '250' },
    ];
    // Bound parameters, as the Worker runs it: batches stay under D1's 100-binding limit.
    const bound = await loadCardRows(env.DB, { printings });
    expect(new Set(bound.map((row) => row.oracle_id))).toEqual(new Set(['forest-oracle']));
    // Inlined values in large batches, as the migration script runs it through wrangler.
    const inlined = {
      prepare: (sql) => ({ bind: (...params) => ({ all: () => env.DB.prepare(inlineParams(sql, params)).all() }) }),
    };
    const big = await loadCardRows(inlined, { printings }, { maxParams: 800 });
    expect(new Set(big.map((row) => row.oracle_id))).toEqual(new Set(['forest-oracle']));
  });

  it('batches past D1’s parameter limit', async () => {
    const names = [...Array.from({ length: 250 }, (_, index) => `Missing ${index}`), 'Forest'];
    const rows = await loadCardRows(env.DB, { names });
    expect(new Set(rows.map((row) => row.oracle_id))).toEqual(new Set(['forest-oracle']));
  });

  it('indexes the loaded subset the way the local cache was indexed', async () => {
    const { index } = await cardIndexFor(
      env.DB,
      await loadCardRows(env.DB, { names: ['Forest', 'Delver of Secrets'] }),
    );
    expect(index.lookup({ name: 'Delver of Secrets' }).card.id).toBe('delver-of-secrets-insectile-aberration-print');
    expect(index.lookup({ name: 'forest' }).card.id).toBe('forest-print');
    expect(index.printing('prm', '250').id).toBe('forest-promo');
    expect(index.isFromBulk()).toBe(true);
    expect(index.lookup({ name: 'Ayula, Queen Among Bears' }).problem).toMatch(/not in card cache/);
  });

  it('loads every card matching a SQL filter', async () => {
    const green = await loadMatchingRows(env.DB, {
      sql: 'c.legal_commander = 1 AND (c.color_identity & ~?) = 0',
      params: [16],
    });
    expect(new Set(green.map((row) => row.name))).toEqual(new Set(['Forest', 'Ayula, Queen Among Bears']));
  });
});

describe('src/core on D1-loaded cards', () => {
  it('checks a deck with mtg-manager’s rules', async () => {
    const { index } = await cardIndexFor(
      env.DB,
      await loadCardRows(env.DB, { names: ['Forest', 'Ayula, Queen Among Bears'] }),
    );
    const deck = {
      schema_version: 1,
      name: 'Bears',
      format: 'commander',
      status: 'draft',
      allow_proxies: false,
      unlimited_basics: true,
      primer: 'Bears.',
      commanders: [{ name: 'Ayula, Queen Among Bears', quantity: 1 }],
      mainboard: [{ name: 'Forest', quantity: 99, role: 'land' }],
    };
    const owned = [
      {
        name: 'Ayula, Queen Among Bears',
        quantity: 1,
        scryfallId: 'ayula-queen-among-bears-print',
        collection: 'binder',
      },
    ];
    const collections = { available: owned, protected: [], availableNames: ['binder'], sources: [] };
    const report = checkDeck(deck, collections, index, { now: Date.parse(INGESTED) });
    expect(report.total).toBe(100);
    expect(report.outcome).toBe('pass');
  });
});
