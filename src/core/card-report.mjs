// What the workspace knows about a card, whether or not it's owned (card:show), and about the card
// cache itself (collection:check).
import { ageInDays } from './card.mjs';
import { ownedCounts, protectedHoldings } from './collection.mjs';
import { roleLabels } from './deck.mjs';
import { cheapestPrice } from './upgrades.mjs';

// Every place a deck names a card: as a commander, in the mainboard (with its roles), in an upgrade's
// add or cut, or in considered (with its reason).
function deckUses(card, decks, index) {
  const named = (entry) => index.lookup(entry).card?.oracleId === card.oracleId;
  return decks.flatMap(({ slug, deck }) => [
    ...deck.commanders.filter(named).map(() => ({ deck: slug, as: 'commander' })),
    ...deck.mainboard.filter(named).map((entry) => ({ deck: slug, as: 'mainboard', roles: roleLabels(entry) })),
    ...(deck.upgrades ?? []).filter(({ add }) => named(add)).map(() => ({ deck: slug, as: 'upgrade add' })),
    ...(deck.upgrades ?? []).filter(({ cut }) => named(cut)).map(() => ({ deck: slug, as: 'upgrade cut' })),
    ...(deck.considered ?? [])
      .filter(({ name }) => named({ name }))
      .map(({ reason }) => ({ deck: slug, as: 'considered', reason })),
  ]);
}

// One report per name: the card and its values, copies and deck uses, or the lookup problem (with
// suggestions) for a name the cache lacks.
export function cardReports(names, { index, collections, decks }) {
  const owned = ownedCounts(collections.available, index);
  const holdings = protectedHoldings(collections.protected, index);
  return names.map((name) => {
    const { card, problem } = index.lookup({ name });
    if (problem) return { name, problem, suggestions: index.suggestNames(name) };
    return {
      name,
      card,
      priceUsd: cheapestPrice(index, card),
      edhrecRank: card.edhrecRank ?? null,
      printings: index.printingsOf(card.oracleId).length,
      available: owned.counts.get(card.oracleId) ?? 0,
      protectedIn: holdings.get(card.oracleId) ?? [],
      uses: deckUses(card, decks, index),
    };
  });
}

// How much the cache holds, whether it came from bulk data, and how old its data is. A cache written
// before refreshedAt was recorded is dated by its newest printing.
export function cacheStatus(cache, index, now = Date.now()) {
  const printings = [...index.byId.values()];
  const newest = printings.reduce(
    (latest, card) => (!latest || card.fetchedAt > latest ? card.fetchedAt : latest),
    null,
  );
  const refreshedAt = cache.refreshedAt ?? newest;
  return {
    printings: printings.length,
    cards: new Set(printings.map((card) => card.oracleId)).size,
    fromBulk: index.isFromBulk(),
    bulkBuiltAt: cache.bulkBuiltAt ?? printings.find((card) => card.defaultPrinting)?.fetchedAt ?? null,
    refreshedAt,
    daysSinceRefresh: refreshedAt ? Math.floor(ageInDays({ fetchedAt: refreshedAt }, now)) : null,
  };
}
