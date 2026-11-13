import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  availableCopies,
  holdDeckCards,
  ownedCounts,
  parseCollection,
  parseTextCollection,
  resolveTextRows,
  summarize,
} from '../../src/core/collection.mjs';
import { card, forest, indexOf, row, spell } from './fixtures.mjs';

const HEADER = 'Name,Quantity,Scryfall ID,Set code,Collector number,Foil,Proxy';
const SCRYFALL_ID = 'b3988120-ebbe-4d24-9bb4-8c5331a14034';
const csvRow = (quantity = '1') => `"Example, Card // Back",${quantity},${SCRYFALL_ID},TST,001a,normal,false`;

test('parseCollection keeps quoted names, collector strings and repeated rows', () => {
  const rows = parseCollection(`\uFEFF${HEADER}\r\n${csvRow('2')}\r\n${csvRow('3')}\r\n`);
  assert.equal(rows[0].name, 'Example, Card // Back');
  assert.equal(rows[0].collectorNumber, '001a');
  assert.deepEqual(summarize(rows), { rowCount: 2, copies: 5, distinctNames: 1, proxyCopies: 0 });
});

test('parseCollection rejects quantities that are not positive integers', () => {
  for (const quantity of ['0', '-1', '1.5', '', 'Infinity', '9007199254740992']) {
    assert.throws(() => parseCollection(`${HEADER}\n${csvRow(quantity)}`), /Quantity/, quantity);
  }
});

test('parseCollection rejects bad headers, empty exports, IDs and proxy flags', () => {
  assert.throws(() => parseCollection('Name,Quantity\nForest,1'), /missing headers/);
  assert.throws(() => parseCollection(`${HEADER},Name\n${csvRow()},Forest`), /duplicate headers/);
  assert.throws(() => parseCollection(HEADER), /no card rows/);
  assert.throws(() => parseCollection(`${HEADER}\n${csvRow().replace(SCRYFALL_ID, 'bad')}`), /Scryfall ID/);
  assert.throws(() => parseCollection(`${HEADER}\n${csvRow().replace('false', 'maybe')}`), /Proxy/);
});

test('parseCollection reads binder exports without a Proxy column as real cards', () => {
  const rows = parseCollection(
    `Binder Name,Binder Type,Name,Quantity,Scryfall ID,Set code,Collector number,Foil\n` +
      `beholder,deck,Forest,2,${SCRYFALL_ID},TST,001,normal\nall cards,binder,Forest,3,${SCRYFALL_ID},TST,001,normal`,
  );
  assert.deepEqual(
    rows.map(({ isProxy, inDeckBinder }) => ({ isProxy, inDeckBinder })),
    [
      { isProxy: false, inDeckBinder: true },
      { isProxy: false, inDeckBinder: false },
    ],
  );
});

test('holdDeckCards holds every copy of a card named in a deck binder', () => {
  const inDeck = { ...row(forest, 1), inDeckBinder: true };
  const spare = row(forest, 4);
  const free = row(spell, 2);
  assert.deepEqual(holdDeckCards([inDeck, spare, free]), { free: [free], held: [inDeck, spare] });
});

test('ownedCounts merges printings by oracle ID and counts rows missing from the cache', () => {
  const variant = { ...forest, id: 'second-print' };
  const rows = [row(forest, 2), row(variant, 3), { ...row(forest, 1), scryfallId: 'uncached' }];
  assert.deepEqual(ownedCounts(rows, indexOf(forest, variant)), {
    counts: new Map([['forest', 5]]),
    unresolvedRows: 1,
  });
});

test('ownedCounts includes proxy rows only when allowed', () => {
  const rows = [row(forest, 2), row(forest, 4, { isProxy: true })];
  assert.equal(ownedCounts(rows, indexOf(forest)).counts.get('forest'), 2);
  assert.equal(ownedCounts(rows, indexOf(forest), { allowProxies: true }).counts.get('forest'), 6);
});

test('availableCopies treats basics as unlimited only when the deck says so', () => {
  const owned = ownedCounts([row(forest, 5), row(spell, 1)], indexOf(forest, spell));
  assert.equal(availableCopies(owned, forest), 5);
  assert.equal(availableCopies(owned, forest, { unlimitedBasics: true }), Infinity);
  assert.equal(availableCopies(owned, spell, { unlimitedBasics: true }), 1);
});

test('parseTextCollection reads Moxfield, Archidekt and Arena lines, skipping headings and comments', () => {
  const text = [
    '\uFEFFCommander',
    '1 Leonardo, the Balance (TMC) 1 *F*',
    '',
    'Deck',
    '// a comment',
    '4x Forest (tmt) 319',
    '1x Sol Ring (FDC) 286 *E* [Upgrade,Ramp] ^Buy,#00ff00^',
    '2 Arcane Signet',
    'SIDEBOARD:',
    '1 Dusk / Dawn (LTC) 166\r',
  ].join('\n');
  const rows = parseTextCollection(text, 'Box');
  assert.deepEqual(
    rows.map(({ name, quantity, set, collectorNumber, finish }) => [name, quantity, set, collectorNumber, finish]),
    [
      ['Leonardo, the Balance', 1, 'tmc', '1', 'foil'],
      ['Forest', 4, 'tmt', '319', 'normal'],
      ['Sol Ring', 1, 'fdc', '286', 'etched'],
      ['Arcane Signet', 2, undefined, undefined, 'normal'],
      ['Dusk / Dawn', 1, 'ltc', '166', 'normal'],
    ],
  );
  assert.equal(rows[1].location, 'Box: line 6');
  assert.deepEqual(summarize(rows), { rowCount: 5, copies: 9, distinctNames: 5, proxyCopies: 0 });
});

test('parseTextCollection rejects lines it cannot read, zero quantities and empty lists', () => {
  assert.throws(() => parseTextCollection('1 Forest\nForest (TST) 1', 'Box'), /Box: line 2: expected/);
  assert.throws(() => parseTextCollection('0 Forest'), /positive integer/);
  assert.throws(() => parseTextCollection('Deck\n\n'), /no card lines/);
});

test('resolveTextRows matches printings by set and number, accepting single slashes and flavor names', () => {
  const split = card('Dusk // Dawn', { set: 'ltc', collectorNumber: '166', frontName: 'Dusk' });
  const hydra = card('Voracious Hydra', { set: 'tmc', collectorNumber: '54', flavorName: 'Aggro Amalgam' });
  const index = indexOf(split, hydra, spell);
  const rows = parseTextCollection('1 Dusk / Dawn (LTC) 166\n1 Aggro Amalgam (TMC) 54\n2 example spell');
  assert.deepEqual(
    resolveTextRows(rows, index).map(({ name, scryfallId }) => [name, scryfallId]),
    [
      ['Dusk // Dawn', split.id],
      ['Voracious Hydra', hydra.id],
      ['Example Spell', spell.id],
    ],
  );
});

test('resolveTextRows leaves uncached lines unmatched and rejects wrong names and ambiguous names', () => {
  const index = indexOf(forest, card('Twin', { id: 'a', oracleId: 'a' }), card('Twin', { id: 'b', oracleId: 'b' }));
  const [uncached] = resolveTextRows(parseTextCollection('1 Island (TST) 2'), index);
  assert.equal(uncached.scryfallId, undefined);
  assert.throws(
    () => resolveTextRows(parseTextCollection('1 Island (TST) 1', 'Box'), index),
    /Box: line 1: TST 1 is Forest, not Island/,
  );
  assert.throws(() => resolveTextRows(parseTextCollection('1 Twin'), index), /more than one card/);
});
