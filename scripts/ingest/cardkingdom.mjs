// Card Kingdom's retail prices, from its public price list, keyed by Scryfall printing ID. One store's
// prices for a whole order are what a person actually pays, where Scryfall's USD price is TCGplayer's
// market price across many sellers, each shipping separately. Web APIs only, like rows.mjs.

export const PRICE_LIST_URL = 'https://api.cardkingdom.com/api/v2/pricelist';
// Card Kingdom lists well over 100,000 entries; far fewer means a bad download, not a smaller store.
export const MIN_ENTRIES = 10_000;

// { scryfallId: { price, inStock } } for every nonfoil printing Card Kingdom sells: the cheapest
// near-mint price among copies in stock, else among all its listings of that printing.
export function cardKingdomPrices(body) {
  if (!Array.isArray(body?.data) || body.data.length < MIN_ENTRIES) {
    throw new Error('Card Kingdom price list is missing or much shorter than expected');
  }
  const prices = new Map();
  for (const entry of body.data) {
    const quote = nonfoilQuote(entry);
    if (quote && isBetter(quote, prices.get(entry.scryfall_id))) prices.set(entry.scryfall_id, quote);
  }
  return prices;
}

// A nonfoil listing's price and stock, or null for a foil, unpriced or unidentified one.
function nonfoilQuote(entry) {
  if (String(entry?.is_foil) !== 'false' || typeof entry.scryfall_id !== 'string') return null;
  const price = Number(entry.price_retail);
  return price > 0 ? { price, inStock: Number(entry.qty_retail) > 0 } : null;
}

const isBetter = (quote, seen) =>
  !seen || (quote.inStock && !seen.inStock) || (quote.inStock === seen.inStock && quote.price < seen.price);

// Printings with Card Kingdom's price and stock added to their prices, as the card model keeps them.
export const withCardKingdom = (printings, prices) =>
  printings.map((printing) => {
    const quote = prices.get(printing.id);
    return {
      ...printing,
      prices: { ...printing.prices, ckUsd: quote ? quote.price.toFixed(2) : null, ckInStock: quote?.inStock ?? null },
    };
  });
