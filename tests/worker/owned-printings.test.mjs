// Loading only the printings src/core reads (owned, default, cheapest, and a search's sets and
// rarities) gives the same answers as loading every printing of every owned card.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrationStatements } from '../../scripts/migrate/plan.mjs';
import { printingChooser } from '../../src/core/export.mjs';
import { searchCollection, searchFilters } from '../../src/core/search.mjs';
import { cheapestPrice, cheapestQuote } from '../../src/core/upgrades.mjs';
import { cardIndexFor, loadMatchingRows, loadOwnedRows } from '../../src/storage/cards.mjs';
import { loadCollections } from '../../src/storage/collections.mjs';
import { scryfallCard } from '../fixtures/scryfall.mjs';
import { BUILT, clearCardTables, ingest } from './ingest-helper.mjs';

const price = (usd, eur = null) => ({ usd, usd_foil: null, usd_etched: null, eur });
const solRing = scryfallCard('Sol Ring', { set: 'c21', collector_number: '263', prices: price('1.50', '1.20') });
const SOL_PRINTINGS = [
  { ...solRing, id: 'sol-cmm', set: 'cmm', collector_number: '400', prices: price('0.99') },
  {
    ...solRing,
    id: 'sol-gold',
    set: 'wc97',
    collector_number: '1',
    border_color: 'gold',
    prices: price('0.10', '0.05'),
  },
  { ...solRing, id: 'sol-30a', set: '30a', set_type: 'memorabilia', collector_number: '2', prices: price('0.05') },
  { ...solRing, id: 'sol-ltc', set: 'ltc', collector_number: '1', prices: price('2.00', '0.50') },
  { ...solRing, id: 'sol-sld', set: 'sld', collector_number: '9', rarity: 'rare', prices: price('5.00') },
];
const goldOnly = scryfallCard('Gold Only', { border_color: 'gold', prices: price('3.00') });
const GOLD_PRINTINGS = [{ ...goldOnly, id: 'gold-only-b', collector_number: '2', prices: price('2.00') }];
const unpriced = scryfallCard('Unpriced', { prices: price(null) });
const trekker = scryfallCard('Trekker', { set: 'xyz', rarity: 'common', prices: price('0.25') });
const TREKKER_PRINTINGS = [
  { ...trekker, id: 'trekker-trk', set: 'trk', collector_number: '158', rarity: 'rare', prices: price('4.00') },
  {
    ...trekker,
    id: 'trekker-trk-showcase',
    set: 'trk',
    collector_number: '300',
    rarity: 'mythic',
    prices: price('9.00'),
  },
];
const unowned = scryfallCard('Unowned', { prices: price('0.01') });
const USER = 'user-parity';

let collections;
let full;
let reduced;
let reducedForSearch;

beforeAll(async () => {
  await clearCardTables();
  await env.DB.batch(
    ['collection_entries', 'collections', 'decks'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
  await ingest(
    [solRing, goldOnly, unpriced, trekker, unowned],
    [...SOL_PRINTINGS, ...GOLD_PRINTINGS, ...TREKKER_PRINTINGS],
  );
  const row = (name, id, position) => ({
    name,
    quantity: 1,
    scryfallId: id,
    finish: 'normal',
    isProxy: false,
    inDeckBinder: false,
    position,
  });
  const statements = migrationStatements(
    [
      {
        userId: USER,
        email: 'parity@example.com',
        existing: true,
        collections: [
          {
            name: 'binder',
            path: 'collections/binder.csv',
            format: 'manabox_csv',
            isProtected: false,
            rows: [
              row('Sol Ring', 'sol-sld', 0),
              row('Gold Only', 'gold-only-print', 1),
              row('Unpriced', 'unpriced-print', 2),
              row('Trekker', 'trekker-print', 3),
            ],
            records: [],
          },
        ],
        decks: [],
      },
    ],
    BUILT,
  );
  for (const statement of statements) await env.DB.prepare(statement).run();
  collections = await loadCollections(env.DB, USER);
  const owned = ['sol-ring-oracle', 'gold-only-oracle', 'unpriced-oracle', 'trekker-oracle'];
  full = (
    await cardIndexFor(
      env.DB,
      await loadMatchingRows(env.DB, { sql: `c.oracle_id IN (${owned.map(() => '?').join(', ')})`, params: owned }),
    )
  ).index;
  reduced = (await cardIndexFor(env.DB, await loadOwnedRows(env.DB, USER))).index;
  reducedForSearch = (
    await cardIndexFor(env.DB, await loadOwnedRows(env.DB, USER, { sets: ['trk'], rarities: ['rare'] }))
  ).index;
});

const OWNED = ['Sol Ring', 'Gold Only', 'Unpriced', 'Trekker'];
const cardIn = (index, name) => index.lookup({ name }).card;

describe('the reduced owned printings', () => {
  it('load far fewer printings', () => {
    expect(full.byId.size).toBe(12);
    expect(reduced.byId.size).toBeLessThan(full.byId.size);
    expect(reduced.byId.has('sol-gold')).toBe(false);
  });

  it('give the same cheapest prices in USD and EUR', () => {
    for (const name of OWNED) {
      for (const currency of ['USD', 'EUR']) {
        expect(cheapestPrice(reduced, cardIn(reduced, name), currency), `${name} ${currency}`).toBe(
          cheapestPrice(full, cardIn(full, name), currency),
        );
      }
    }
    expect(cheapestPrice(reduced, cardIn(reduced, 'Sol Ring'))).toBe(0.99);
    expect(cheapestPrice(reduced, cardIn(reduced, 'Sol Ring'), 'EUR')).toBe(0.5);
    expect(cheapestPrice(reduced, cardIn(reduced, 'Gold Only'))).toBe(2);
    expect(cheapestPrice(reduced, cardIn(reduced, 'Unpriced'))).toBeNull();
  });

  it('give the same fresh quotes, from the same printing', () => {
    const now = Date.parse(BUILT);
    for (const name of OWNED) {
      for (const currency of ['USD', 'EUR']) {
        const [a, b] = [full, reduced].map((index) =>
          cheapestQuote(index, { card: cardIn(index, name) }, { currency, now }),
        );
        expect({ cents: b.unitCents, printing: b.printing?.id, problem: b.problem }, `${name} ${currency}`).toEqual({
          cents: a.unitCents,
          printing: a.printing?.id,
          problem: a.problem,
        });
      }
    }
  });

  it('give the same search results, sorted by price', () => {
    const run = (index, options = {}) =>
      searchCollection(collections, index, searchFilters(options, index)).results.map((result) => [
        result.card.name,
        result.available,
        result.priceUsd,
        result.printing?.id,
      ]);
    expect(run(reduced)).toEqual(run(full));
    expect(run(reducedForSearch, { set: ['trk'], rarity: ['rare'] })).toEqual(
      run(full, { set: ['trk'], rarity: ['rare'] }),
    );
    expect(run(reducedForSearch, { set: ['trk'], rarity: ['rare'] })).toEqual([['Trekker', 1, 0.25, 'trekker-trk']]);
  });

  it('choose the same printings for exports', () => {
    const choose = (index) => {
      const printingOf = printingChooser(index, collections.available);
      return OWNED.map((name) => printingOf({ name })?.id);
    };
    expect(choose(reduced)).toEqual(choose(full));
    expect(choose(reduced)[0]).toBe('sol-sld');
  });

  it('keep Scryfall’s default printing first', () => {
    for (const name of OWNED) {
      const oracleId = cardIn(full, name).oracleId;
      expect(reduced.printingsOf(oracleId)[0].id).toBe(full.printingsOf(oracleId)[0].id);
    }
  });
});
