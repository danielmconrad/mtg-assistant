import { test } from 'vitest';
import assert from 'node:assert/strict';
import { exportDeck, printingChooser } from '../../src/core/export.mjs';
import { card, entry, forest, indexOf, row } from './fixtures.mjs';

const RING_ID = 'ring-print';
const ring = card('Sol Ring', { id: RING_ID, set: 'cmr', collectorNumber: '472' });
const deck = {
  commanders: [entry('Example Leader')],
  mainboard: [entry('Sol Ring', 1, { role: 'ramp, artifact', scryfall_id: RING_ID }), entry('Forest', 98)],
};
const printingOf = (value) => (value.scryfall_id === RING_ID ? ring : null);

test('text export lists commanders, then the mainboard, by name only', () => {
  assert.equal(exportDeck(deck, { printingOf }), 'Commander\n1 Example Leader\n\n1 Sol Ring\n98 Forest\n');
});

test('Moxfield export uses Arena sections and pinned printings', () => {
  assert.equal(
    exportDeck(deck, { format: 'moxfield', printingOf }),
    'Commander\n1 Example Leader\n\nDeck\n1 Sol Ring (CMR) 472\n98 Forest\n',
  );
});

test('Moxfield export omits the Commander section for casual decks', () => {
  assert.equal(exportDeck({ ...deck, commanders: [] }, { format: 'moxfield' }), 'Deck\n1 Sol Ring\n98 Forest\n');
});

test('Archidekt export tags commanders and turns roles into Title Case categories', () => {
  assert.equal(
    exportDeck(deck, { format: 'archidekt', printingOf }),
    '1x Example Leader [Commander{top}]\n1x Sol Ring (CMR) 472 [Ramp,Artifact]\n98x Forest\n',
  );
});

test('unknown export formats are rejected with the valid choices', () => {
  assert.throws(() => exportDeck(deck, { format: 'tappedout' }), /text, moxfield, archidekt/);
});

test('printingChooser prefers the pin, then the most-owned non-proxy printing, then any cached printing', () => {
  const ownedForest = { ...forest, id: 'owned-forest', set: 'ltr', collectorNumber: '280' };
  const proxyForest = { ...forest, id: 'proxy-forest', set: 'pxy' };
  const index = indexOf(forest, ownedForest, proxyForest, ring);
  const missing = new Set();
  const printingOf = printingChooser(
    index,
    [row(proxyForest, 9, { isProxy: true }), row(forest, 3), row(ownedForest, 5), row(forest, 1)],
    missing,
  );
  assert.equal(printingOf(entry('Forest')), ownedForest);
  assert.equal(printingOf(entry('Forest', 1, { scryfall_id: forest.id })), forest);
  assert.equal(printingOf(entry('Sol Ring')), ring);
  assert.equal(printingOf(entry('Unknown Card')), null);
  assert.equal(printingOf(entry('Forest', 1, { scryfall_id: 'not-cached' })), null);
  assert.deepEqual([...missing], ['Unknown Card', 'Forest']);
});

test('each format lists upgrade cards in the deck, and swap-out and considered cards outside it', () => {
  const withSideboard = {
    ...deck,
    mainboard: [entry('Forest', 98)],
    swapOut: [entry('Sol Ring', 1, { role: 'ramp', scryfall_id: RING_ID })],
    considering: [entry('Example Spell', 1, { role: 'draw' })],
  };
  assert.equal(
    exportDeck(withSideboard),
    'Commander\n1 Example Leader\n\n98 Forest\n\nSwap Out\n1 Sol Ring\n\nConsidering\n1 Example Spell\n',
  );
  const withUpgradesIn = {
    ...deck,
    mainboard: [entry('Forest', 98)],
    upgradesIn: [entry('Sol Ring', 1, { role: 'ramp', scryfall_id: RING_ID })],
  };
  assert.match(exportDeck(withUpgradesIn), /98 Forest\n\nUpgrades\n1 Sol Ring\n$/);
  assert.match(
    exportDeck(withUpgradesIn, { format: 'moxfield', printingOf }),
    /Deck\n98 Forest\n1 Sol Ring \(CMR\) 472\n$/,
  );
  assert.match(
    exportDeck(withUpgradesIn, { format: 'archidekt', printingOf }),
    /98x Forest\n1x Sol Ring \(CMR\) 472 \[Upgrade,Ramp\]\n$/,
  );
  assert.match(
    exportDeck(withSideboard, { format: 'moxfield', printingOf }),
    /Deck\n98 Forest\n\nSideboard\n1 Sol Ring \(CMR\) 472\n\nConsidering\n1 Example Spell\n$/,
  );
  assert.match(
    exportDeck(withSideboard, { format: 'archidekt', printingOf }),
    /98x Forest\n1x Sol Ring \(CMR\) 472 \[Sideboard\]\n1x Example Spell \[Maybeboard\]\n$/,
  );
});
