import { ageInDays, isPlayablePrinting } from './card.mjs';
import { availableCopies, ownedCounts } from './collection.mjs';
import { addCopies, deckEntries, removeCopies, resolveEntries } from './deck.mjs';

export const PRICE_MAX_AGE_DAYS = 7;
const PRICE_PATTERN = /^\d+(\.\d{1,2})?$/;
export const CENTS_PER_UNIT = 100;

const toCents = (amount) => Math.round(amount * CENTS_PER_UNIT);

// A card's printings that can set its price: the playable ones, or every printing if none is.
function pricedPrintings(index, card) {
  const printings = index.printingsOf(card.oracleId);
  const playable = printings.filter(isPlayablePrinting);
  return playable.length ? playable : printings;
}

// Where a currency's quotes come from, most trusted first: the first source with a quote sets the
// price. In USD that's Card Kingdom (copies in stock first), since one store's prices are what a whole
// order really costs, then Scryfall's USD price, TCGplayer's market price across many sellers who each
// charge shipping. Other currencies are Scryfall's alone.
const SOURCES = {
  USD: [
    { name: 'Card Kingdom', price: (prices) => prices.ckUsd, inStock: (prices) => prices.ckInStock },
    { name: 'TCGplayer', price: (prices) => prices.usd },
  ],
};
const sourcesFor = (currency) =>
  SOURCES[currency] ?? [{ name: 'Scryfall', price: (prices) => prices[currency.toLowerCase()] }];

const outOfStock = (quote) => Number(quote.inStock === false);

// The best quote among printings from the first of sources that has one, or null: in stock before out
// of stock, then cheapest.
function bestQuote(printings, sources, accept = () => true) {
  for (const source of sources) {
    const quotes = printings
      .map((printing) => ({ printing, price: source.price(printing.prices ?? {}) }))
      .filter(({ price }) => PRICE_PATTERN.test(price ?? '') && accept(Number(price)))
      .map(({ printing, price }) => ({
        printing,
        unitCents: toCents(Number(price)),
        source: source.name,
        inStock: source.inStock?.(printing.prices) ?? null,
      }));
    if (quotes.length) {
      return quotes.reduce((best, quote) =>
        (outOfStock(quote) - outOfStock(best) || quote.unitCents - best.unitCents) < 0 ? quote : best,
      );
    }
  }
  return null;
}

// The cheapest quote in a currency among a card's playable printings, whatever its age, or null. It
// steers attention and filters searches; deck:upgrades and price caps use cheapestQuote's fresh quotes.
export function cheapestPrice(index, card, currency = 'USD') {
  const quote = bestQuote(pricedPrintings(index, card), sourcesFor(currency), (price) => price > 0);
  return quote ? quote.unitCents / CENTS_PER_UNIT : null;
}

// Each source's best quote for a card in a currency, whatever its age, most trusted source first.
export const quotesBySource = (index, card, currency = 'USD') =>
  sourcesFor(currency)
    .map((source) => bestQuote(pricedPrintings(index, card), [source], (price) => price > 0))
    .filter(Boolean);

// Cheapest fresh quote: the pinned printing when there is one, else any playable cached printing. A
// quote from a preferred source notes a cheaper one from a later source as `elsewhere`.
export function cheapestQuote(index, { card, printingId }, { currency, now }) {
  const candidates = printingId ? [index.byId.get(printingId)] : pricedPrintings(index, card);
  const fresh = candidates.filter((printing) => ageInDays(printing, now) <= PRICE_MAX_AGE_DAYS);
  if (!fresh.length) return { problem: `price data older than ${PRICE_MAX_AGE_DAYS} days; run scryfall:refresh` };
  const sources = sourcesFor(currency);
  const quote = bestQuote(fresh, sources);
  if (!quote) return { problem: `no ${currency} quote on Scryfall` };
  const later = sources.slice(sources.findIndex((source) => source.name === quote.source) + 1);
  const elsewhere = bestQuote(fresh, later);
  return elsewhere && elsewhere.unitCents < quote.unitCents ? { ...quote, elsewhere } : quote;
}

// The baseline list with every swap applied. Unbalanced swaps and cuts of cards the mainboard
// doesn't hold are input errors and throw; cards missing from the cache are reported as problems.
function applyUpgrades(deck, index) {
  const { tallies: finalList, problems } = resolveEntries(deckEntries(deck), index);
  const { tallies: cuttable } = resolveEntries(deck.mainboard, index);
  for (const swap of deck.upgrades ?? []) {
    if (swap.add.quantity !== swap.cut.quantity) {
      throw new Error(`${swap.add.name} for ${swap.cut.name}: add and cut quantities must match`);
    }
    const cut = index.lookup(swap.cut);
    const add = index.lookup(swap.add);
    if (cut.problem || add.problem) {
      problems.push(...[cut.problem, add.problem].filter(Boolean));
      continue;
    }
    removeCopies(cuttable, cut.card, swap.cut.quantity);
    removeCopies(finalList, cut.card, swap.cut.quantity);
    addCopies(finalList, add.card, swap.add.quantity, swap.add.scryfall_id);
  }
  return { finalList, problems };
}

function purchaseFor(tally, owned, deck, index, now) {
  const quantity = tally.quantity - availableCopies(owned, tally.card, { unlimitedBasics: deck.unlimited_basics });
  if (quantity <= 0) return null;
  const quote = cheapestQuote(index, tally, { currency: deck.budget.currency, now });
  return { card: tally.card, quantity, ...quote };
}

function budgetOutcome(isComplete, totalCents, budgetCents) {
  if (!isComplete) return 'incomplete';
  return totalCents <= budgetCents ? 'pass' : 'fail';
}

// Prices every card the upgraded list needs that the available collections cannot supply.
export function upgradeReport(deck, collections, index, { now = Date.now() } = {}) {
  if (!deck.budget) throw new Error('Set budget.amount and budget.currency before estimating upgrades');
  const { finalList, problems } = applyUpgrades(deck, index);
  const owned = ownedCounts(collections.available, index, { allowProxies: deck.allow_proxies });
  const purchases = [...finalList.values()].map((tally) => purchaseFor(tally, owned, deck, index, now)).filter(Boolean);
  const totalCents = purchases.reduce(
    (sum, purchase) => sum + (purchase.problem ? 0 : purchase.quantity * purchase.unitCents),
    0,
  );
  const budgetCents = toCents(deck.budget.amount);
  const isComplete = !problems.length && !owned.unresolvedRows && purchases.every((purchase) => !purchase.problem);
  return {
    currency: deck.budget.currency,
    purchases,
    problems,
    unresolvedRows: owned.unresolvedRows,
    totalCents,
    budgetCents,
    outcome: budgetOutcome(isComplete, totalCents, budgetCents),
  };
}
