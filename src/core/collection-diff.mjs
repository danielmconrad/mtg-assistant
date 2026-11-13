// collection:diff's comparison: what each collection file holds now against an earlier version, by card
// name, and which decks name the cards that changed.
import { normalizeName } from './card.mjs';

// Copies per card name across a collection's rows, keyed by normalized name.
function copiesByName(rows) {
  const copies = new Map();
  for (const { name, quantity } of rows) {
    const key = normalizeName(name);
    const entry = copies.get(key) ?? { name, copies: 0 };
    entry.copies += quantity;
    copies.set(key, entry);
  }
  return copies;
}

// before and after map each collection's name to its rows. Each change is { collection, status, cards }
// with status added, removed or changed, and cards [{ name, change }] in name order.
export function collectionChanges(before, after) {
  const changes = [];
  for (const collection of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const old = copiesByName(before.get(collection) ?? []);
    const now = copiesByName(after.get(collection) ?? []);
    const cards = [...new Set([...old.keys(), ...now.keys()])]
      .map((key) => ({
        name: (now.get(key) ?? old.get(key)).name,
        change: (now.get(key)?.copies ?? 0) - (old.get(key)?.copies ?? 0),
      }))
      .filter(({ change }) => change)
      .sort((first, second) => first.name.localeCompare(second.name));
    if (!cards.length) continue;
    const status = (!before.has(collection) && 'added') || (!after.has(collection) && 'removed') || 'changed';
    changes.push({ collection, status, cards });
  }
  return changes;
}

// The decks naming any changed card, as commander, in the mainboard or in an upgrade: [{ deck, cards }].
export function decksNaming(changes, decks) {
  const changed = new Map(changes.flatMap(({ cards }) => cards.map(({ name }) => [normalizeName(name), name])));
  return decks
    .map(({ slug, deck }) => {
      const entries = [
        ...deck.commanders,
        ...deck.mainboard,
        ...(deck.upgrades ?? []).flatMap(({ add, cut }) => [add, cut]),
      ];
      const cards = [...new Set(entries.map(({ name }) => changed.get(normalizeName(name))).filter(Boolean))];
      return { deck: slug, cards };
    })
    .filter(({ cards }) => cards.length);
}
