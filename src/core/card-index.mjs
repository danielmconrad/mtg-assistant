import { hasName, normalizeName } from './card.mjs';

function getOrCreate(map, key, create) {
  if (!map.has(key)) map.set(key, create());
  return map.get(key);
}

// Scryfall's default printing first, so a card nobody owns exports as Scryfall would show it. The
// sort is stable, so other printings keep the cache's order.
const defaultFirst = (first, second) => Number(second.defaultPrinting) - Number(first.defaultPrinting);

// The edit distance between two strings, giving up once it exceeds limit.
function editDistance(first, second, limit) {
  if (Math.abs(first.length - second.length) > limit) return limit + 1;
  let previous = Array.from({ length: second.length + 1 }, (_, position) => position);
  for (let row = 1; row <= first.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= second.length; column += 1) {
      const substitution = previous[column - 1] + (first[row - 1] === second[column - 1] ? 0 : 1);
      current.push(Math.min(substitution, previous[column] + 1, current[column - 1] + 1));
    }
    if (Math.min(...current) > limit) return limit + 1;
    previous = current;
  }
  return previous[second.length];
}

const SUGGESTION_COUNT = 3;

const isLegalSomewhere = (card) =>
  Object.values(card.legalities).some((status) => status === 'legal' || status === 'restricted');

export function cardIndex(cache) {
  const byId = new Map(Object.entries(cache.cards));
  const byOracleId = new Map();
  const oracleIdsByName = new Map();
  const byPrinting = new Map();
  const printingKey = (set, collectorNumber) => `${set}|${collectorNumber}`.toLowerCase();
  for (const card of byId.values()) {
    const printings = byOracleId.get(card.oracleId);
    if (printings) {
      printings.push(card);
    } else {
      byOracleId.set(card.oracleId, [card]);
      // Every printing of a card shares its names, so they're indexed from the first one.
      for (const name of new Set([card.name, card.frontName])) {
        getOrCreate(oracleIdsByName, normalizeName(name), () => new Set()).add(card.oracleId);
      }
    }
    getOrCreate(byPrinting, printingKey(card.set, card.collectorNumber), () => card);
  }
  for (const printings of byOracleId.values()) printings.sort(defaultFirst);

  // A name shared by several cards means the one legal in some format, if only one is: bulk data
  // gives real cards' names to tokens, art cards and playtest cards too.
  function oracleIdFor(name) {
    const oracleIds = [...(oracleIdsByName.get(normalizeName(name)) ?? [])];
    if (oracleIds.length < 2) return { oracleId: oracleIds[0] };
    const legal = oracleIds.filter((oracleId) => isLegalSomewhere(byOracleId.get(oracleId)[0]));
    return legal.length === 1 ? { oracleId: legal[0] } : { ambiguous: true };
  }

  // Returns { card } or { problem }. A name gives the card's first printing, which stands in for its
  // rules identity.
  function lookup({ name, scryfall_id: scryfallId }) {
    if (scryfallId) {
      const card = byId.get(scryfallId);
      if (!card) return { problem: `${name}: Scryfall ID not cached; run scryfall:refresh` };
      if (!hasName(card, name)) return { problem: `${name}: name does not match Scryfall ID (${card.name})` };
      return { card };
    }
    const { oracleId, ambiguous } = oracleIdFor(name);
    if (ambiguous) return { problem: `${name}: ambiguous name; add scryfall_id` };
    if (!oracleId) return { problem: notCachedProblem(name) };
    return { card: byOracleId.get(oracleId)[0] };
  }

  // Cached names close to a misspelled one: within about a quarter of its length in edits, or containing
  // it, closest first.
  function suggestNames(name) {
    const wanted = normalizeName(name);
    const limit = Math.max(2, Math.floor(wanted.length / 4));
    const scored = [];
    for (const [known, oracleIds] of oracleIdsByName) {
      const distance = known.includes(wanted) ? 0 : editDistance(wanted, known, limit);
      if (distance <= limit) scored.push({ distance, name: byOracleId.get([...oracleIds][0])[0].name });
    }
    const names = scored.sort((first, second) => first.distance - second.distance).map((entry) => entry.name);
    return [...new Set(names)].slice(0, SUGGESTION_COUNT);
  }

  // With bulk data every card is cached, so a miss is a misspelling; otherwise it may not be fetched yet.
  function notCachedProblem(name) {
    const suggestions = suggestNames(name);
    const refresh = 'run scryfall:refresh -- --missing';
    if (suggestions.length) {
      const guess = `${name}: not in card cache; did you mean ${suggestions.join(', ')}?`;
      return isFromBulk() ? guess : `${guess} If not, ${refresh}`;
    }
    return `${name}: not in card cache; check the spelling${isFromBulk() ? '' : ` or ${refresh}`}`;
  }

  // A printing by set code and collector number, e.g. ('tmc', '54').
  const printing = (set, collectorNumber) => byPrinting.get(printingKey(set, collectorNumber));

  // Takes a Scryfall identifier ({ id }, { set, collector_number } or { name }) rather than a deck entry.
  function isCached(identifier) {
    if (identifier.id) return byId.has(identifier.id);
    if (identifier.set) return Boolean(printing(identifier.set, identifier.collector_number));
    return oracleIdsByName.has(normalizeName(identifier.name));
  }

  const printingsOf = (oracleId) => byOracleId.get(oracleId) ?? [];
  // Every cached card (oracle ID) that's legal in some format, leaving out bulk data's tokens and art cards.
  const playableOracleIds = () =>
    [...byOracleId.keys()].filter((oracleId) => isLegalSomewhere(printingsOf(oracleId)[0]));
  // Bulk data marks each card's default printing; a cache without one holds only owned and deck cards.
  let fromBulk;
  const isFromBulk = () =>
    (fromBulk ??= Boolean(cache.bulkBuiltAt) || [...byId.values()].some((card) => card.defaultPrinting));

  return { byId, lookup, suggestNames, isCached, printing, printingsOf, playableOracleIds, isFromBulk };
}
