import { hasName, isBasic } from './card.mjs';
import { deckEntries, resolveEntries } from './deck.mjs';

// Physically building a deck moves its cards out of the collections they were counted in and into
// one text list of its own. planBuild chooses the copies and planSwapOut the ones a swap returns; on the
// server, src/mcp/tools/physical.mjs makes the moves as row changes rather than file edits.

// Available non-proxy rows per oracle ID, and the copies available of each printing.
function rowsByCard(collections, index) {
  const rows = new Map();
  const copiesById = new Map();
  for (const row of collections.available) {
    const card = !row.isProxy && index.byId.get(row.scryfallId);
    if (!card) continue;
    rows.set(card.oracleId, [...(rows.get(card.oracleId) ?? []), row]);
    copiesById.set(row.scryfallId, (copiesById.get(row.scryfallId) ?? 0) + row.quantity);
  }
  return { rows, copiesById };
}

// The pinned printing first, then nonfoil copies before foil or etched ones, so a deck doesn't use up
// the special copies when plain ones exist, then the printing with the most copies; the sort is stable,
// so ties keep collection order.
const isNonfoil = (row) => Number(row.finish === 'normal');
const takeOrder = (rows, printingId, copiesById) =>
  rows.toSorted(
    (first, second) =>
      Number(second.scryfallId === printingId) - Number(first.scryfallId === printingId) ||
      isNonfoil(second) - isNonfoil(first) ||
      copiesById.get(second.scryfallId) - copiesById.get(first.scryfallId),
  );

// Chooses which collection rows supply every card in the deck, commanders included. Upgrades are not
// applied, since their adds may not be owned. A card's pinned printing is taken first, then nonfoil
// copies, then the printing with the most available copies, then the rest in collection order.
// Proxies are never taken: a text list can't mark them. With unlimited_basics, basics the collections
// lack come from untracked basics instead. Returns takes ({ row, card, quantity, isCommander }),
// untracked ({ card, quantity }), and problems, which mean nothing should be built.
export function planBuild(deck, collections, index) {
  const { tallies, problems } = resolveEntries(deckEntries(deck), index);
  const commanders = resolveEntries(deck.commanders, index).tallies;
  const { rows, copiesById } = rowsByCard(collections, index);
  const takes = [];
  const untracked = [];
  for (const { card, quantity, printingId } of tallies.values()) {
    let needed = quantity;
    for (const row of takeOrder(rows.get(card.oracleId) ?? [], printingId, copiesById)) {
      if (!needed) break;
      const taken = Math.min(needed, row.quantity);
      const isCommander = commanders.has(card.oracleId);
      takes.push({ row, card: index.byId.get(row.scryfallId), quantity: taken, isCommander });
      needed -= taken;
    }
    if (!needed) continue;
    if (deck.unlimited_basics && isBasic(card)) {
      untracked.push({ card: index.byId.get(printingId) ?? card, quantity: needed });
    } else {
      problems.push(`${card.name}: need ${quantity}, ${quantity - needed} non-proxy copies available`);
    }
  }
  return { takes, untracked, problems };
}

// Chooses which lines of a built deck's own list hold the copies a swap takes out: cuts maps an
// oracle ID to { card, quantity, printingId }. The pinned printing goes first, then lines in list
// order. Lines without a printing are untracked basics, which go nowhere. Returns takes ({ row, card,
// quantity }), untracked ({ row, name, quantity }) and problems.
export function planSwapOut(ownRows, cuts, index) {
  const takes = [];
  const untracked = [];
  const problems = [];
  for (const { card, quantity, printingId } of cuts.values()) {
    const rows = ownRows.filter((row) =>
      row.scryfallId ? index.byId.get(row.scryfallId)?.oracleId === card.oracleId : hasName(card, row.name),
    );
    const isPinned = (row) => Number(Boolean(row.set) && row.scryfallId === printingId);
    let needed = quantity;
    for (const row of rows.toSorted((first, second) => isPinned(second) - isPinned(first))) {
      if (!needed) break;
      const taken = Math.min(needed, row.quantity);
      if (row.set) takes.push({ row, card: index.byId.get(row.scryfallId), quantity: taken });
      else untracked.push({ row, name: row.name, quantity: taken });
      needed -= taken;
    }
    if (needed) {
      problems.push(`${card.name}: the deck's own list has ${quantity - needed} of the ${quantity} to swap out`);
    }
  }
  return { takes, untracked, problems };
}

const TEXT_FINISHES = { foil: ' *F*', etched: ' *E*' };

// A text list line naming the printing and finish, which parseTextCollection reads back. Untracked
// basics have no known printing, so they're listed by name.
export const printingLine = (quantity, card, finish = 'normal') =>
  `${quantity} ${card.name} (${card.set.toUpperCase()}) ${card.collectorNumber}${TEXT_FINISHES[finish] ?? ''}`;
export const nameLine = (quantity, card) => `${quantity} ${card.name}`;
