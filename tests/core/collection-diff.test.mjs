import { test } from 'vitest';
import assert from 'node:assert/strict';
import { collectionChanges, decksNaming } from '../../src/core/collection-diff.mjs';

const rows = (...pairs) => pairs.map(([name, quantity]) => ({ name, quantity }));

test('collectionChanges nets copies per card name, by collection', () => {
  const before = new Map([
    ['binder', rows(['Sol Ring', 1], ['Forest', 3])],
    ['gone', rows(['Island', 2])],
  ]);
  const after = new Map([
    ['binder', rows(['sol ring', 1], ['Sol Ring', 1], ['Forest', 3])],
    ['new', rows(['Swamp', 1])],
  ]);
  assert.deepEqual(collectionChanges(before, after), [
    { collection: 'binder', status: 'changed', cards: [{ name: 'sol ring', change: 1 }] },
    { collection: 'gone', status: 'removed', cards: [{ name: 'Island', change: -2 }] },
    { collection: 'new', status: 'added', cards: [{ name: 'Swamp', change: 1 }] },
  ]);
});

test('decksNaming lists the decks naming a changed card, upgrades included', () => {
  const decks = [
    { slug: 'a', deck: { commanders: [], mainboard: [{ name: 'Sol Ring', quantity: 1 }] } },
    { slug: 'b', deck: { commanders: [], mainboard: [], upgrades: [{ add: { name: 'Swamp' }, cut: { name: 'x' } }] } },
    { slug: 'c', deck: { commanders: [], mainboard: [{ name: 'Plains', quantity: 1 }] } },
  ];
  const changes = [{ cards: [{ name: 'sol ring' }, { name: 'Swamp' }] }];
  assert.deepEqual(decksNaming(changes, decks), [
    { deck: 'a', cards: ['sol ring'] },
    { deck: 'b', cards: ['Swamp'] },
  ]);
});
