// Card Kingdom's price list as the ingest reads it, and the price rows it stores.
import { describe, expect, it } from 'vitest';
import { MIN_ENTRIES, cardKingdomPrices, withCardKingdom } from '../../scripts/ingest/cardkingdom.mjs';
import { buildRows } from '../../scripts/ingest/rows.mjs';
import { toCard } from '../../src/core/scryfall.mjs';
import { scryfallCard } from '../fixtures/scryfall.mjs';

const entry = (scryfallId, price, qty, isFoil = 'false') => ({
  scryfall_id: scryfallId,
  is_foil: isFoil,
  price_retail: price,
  qty_retail: qty,
});
// Enough unrelated entries to pass the size check.
const filler = Array.from({ length: MIN_ENTRIES }, (_, i) => entry(`filler-${i}`, '0.25', 1));

describe('cardKingdomPrices', () => {
  it('keeps each nonfoil printing’s cheapest in-stock price, else its cheapest', () => {
    const prices = cardKingdomPrices({
      data: [
        ...filler,
        entry('a', '3.99', 0),
        entry('a', '5.99', 2),
        entry('a', '4.99', 1),
        entry('a', '0.99', 5, 'true'),
        entry('b', '2.49', 0),
        entry('b', '1.99', 0),
        entry('c', '0.00', 4),
        { ...entry('d', '1.00', 1), scryfall_id: null },
      ],
    });
    expect(prices.get('a')).toEqual({ price: 4.99, inStock: true });
    expect(prices.get('b')).toEqual({ price: 1.99, inStock: false });
    expect(prices.has('c')).toBe(false);
    expect(prices.size).toBe(MIN_ENTRIES + 2);
  });

  it('refuses a missing or short list', () => {
    expect(() => cardKingdomPrices({})).toThrow('Card Kingdom price list');
    expect(() => cardKingdomPrices({ data: [entry('a', '1.00', 1)] })).toThrow('much shorter than expected');
  });
});

describe('Card Kingdom prices in price rows', () => {
  const card = scryfallCard('Vito, Thorn of the Dusk Rose', { prices: { usd: '1.00' } });
  const printing = (id) => toCard({ ...card, id }, '2026-11-17T00:00:00.000Z', { defaultPrinting: id === 'listed' });

  it('stores the price and stock, and null for printings Card Kingdom doesn’t list', async () => {
    const printings = withCardKingdom(
      [printing('listed'), printing('unlisted')],
      new Map([['listed', { price: 14.99, inStock: false }]]),
    );
    expect(printings[0].prices).toMatchObject({ usd: '1.00', ckUsd: '14.99', ckInStock: false });
    const { prices } = await buildRows(printings);
    expect(prices.map(({ printing_id, ck_usd, ck_in_stock }) => [printing_id, ck_usd, ck_in_stock])).toEqual([
      ['listed', 14.99, 0],
      ['unlisted', null, null],
    ]);
  });
});
