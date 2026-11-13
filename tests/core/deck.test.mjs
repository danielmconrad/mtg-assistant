import { test } from 'vitest';
import assert from 'node:assert/strict';
import { stringify } from 'yaml';
import {
  applyUpgrades,
  newDeck,
  parseDeck,
  removeCopies,
  resolveEntries,
  roleLabels,
  splitUpgrades,
  withDeckField,
  withMainboardSwaps,
} from '../../src/core/deck.mjs';
import { entry, forest, indexOf, leader } from './fixtures.mjs';

const deck = (fields = {}) => ({
  schema_version: 1,
  name: 'Fixture',
  format: 'commander',
  status: 'draft',
  allow_proxies: false,
  primer: 'Test',
  commanders: [entry(leader.name)],
  mainboard: [entry(forest.name, 99)],
  ...fields,
});

test('withDeckField adds a field after another, keeping comments, and validates the result', () => {
  const text = `# keep me\n${stringify(deck({ collection_source: ['collections/brad/*'] }))}`;
  const updated = withDeckField(text, 'collection_destination', 'collections/brad/decks/elves.txt', {
    after: 'collection_source',
  });
  assert.match(updated, /^# keep me\n/);
  assert.match(
    updated,
    /collection_source:\n {2}- collections\/brad\/\*\ncollection_destination: collections\/brad\/decks\/elves.txt\n/,
  );
  assert.throws(() => withDeckField(updated, 'collection_destination', 'collections/x.txt'), /already has/);
  assert.throws(
    () => withDeckField(text, 'collection_destination', 'elsewhere.csv'),
    /collection_destination must match/,
  );
});

test('withMainboardSwaps swaps copies in place, keeping roles and comments', () => {
  const text = [
    'schema_version: 1',
    'name: Fixture',
    'format: casual-60',
    'status: draft',
    'allow_proxies: false',
    'primer: Test',
    'commanders: []',
    'mainboard:',
    '  # draw',
    "  - name: 'Old Draw'",
    '    quantity: 1',
    '    role: draw',
    '  # lands',
    '  - name: Forest',
    '    quantity: 2',
    '    role: land',
    '  - name: Island',
    '    quantity: 1',
    '    role: land',
    '',
  ].join('\n');
  const { text: updated, deck: swapped } = withMainboardSwaps(text, [
    { out: 'old draw', in: 'New Draw' },
    { out: 'Forest', in: 'Island' },
  ]);
  assert.deepEqual(swapped.mainboard, [
    { name: 'New Draw', quantity: 1, role: 'draw' },
    { name: 'Forest', quantity: 1, role: 'land' },
    { name: 'Island', quantity: 2, role: 'land' },
  ]);
  assert.match(updated, /mainboard:\n {2}# draw\n {2}- name: New Draw\n(.|\n)*# lands\n {2}- name: Forest\n/);
  assert.throws(() => withMainboardSwaps(text, [{ out: 'Plains', in: 'Island' }]), /mainboard has no Plains/);
});

test('parseDeck accepts a valid deck, including an empty draft mainboard', () => {
  assert.equal(parseDeck(stringify(deck())).name, 'Fixture');
  assert.deepEqual(parseDeck(stringify(deck({ mainboard: [] }))).mainboard, []);
});

test('parseDeck rejects schema violations', () => {
  const invalidDecks = {
    'unknown key': deck({ typo: true }),
    'no commander': deck({ commanders: [] }),
    'two copies of a commander': deck({ commanders: [entry(leader.name, 2)] }),
    'zero quantity': deck({ mainboard: [entry(forest.name, 0)] }),
    'string boolean': deck({ allow_proxies: 'false' }),
    'casual deck with commanders': deck({ format: 'casual-60' }),
    'Custom Dollar Brawl without a commander': deck({ format: 'custom-dollar-brawl', commanders: [] }),
  };
  for (const [label, invalid] of Object.entries(invalidDecks)) {
    assert.throws(() => parseDeck(stringify(invalid)), /deck:/, label);
  }
});

test('parseDeck rejects duplicate YAML keys', () => {
  assert.throws(() => parseDeck('name: First\nname: Second'), /unique/i);
});

test('newDeck builds a schema-valid draft named after the slug', () => {
  const draft = newDeck('green-value', { commanderNames: [leader.name] });
  assert.equal(draft.name, 'Green Value');
  assert.deepEqual(draft.commanders, [entry(leader.name)]);
  assert.deepEqual(draft.mainboard, []);
});

test('newDeck requires a commander for Commander decks only', () => {
  assert.throws(() => newDeck('green-value'), /--commander/);
  assert.throws(() => newDeck('green-sixty', { format: 'custom-dollar-brawl' }), /--commander/);
  assert.equal(newDeck('mono-g', { format: 'casual-60' }).commanders.length, 0);
});

test('roleLabels splits comma-separated roles and ignores blanks', () => {
  assert.deepEqual(roleLabels(entry('Sol Ring', 1, { role: 'ramp, artifact ,' })), ['ramp', 'artifact']);
  assert.deepEqual(roleLabels(entry('Forest')), []);
});

test('resolveEntries merges printings of one card and records a pinned printing', () => {
  const variant = { ...forest, id: 'second-print' };
  const { tallies, problems } = resolveEntries(
    [entry('Forest', 2), entry('Forest', 3, { scryfall_id: 'second-print' })],
    indexOf(forest, variant),
  );
  assert.deepEqual(problems, []);
  assert.equal(tallies.get('forest').quantity, 5);
  assert.equal(tallies.get('forest').printingId, 'second-print');
});

test('removeCopies refuses to remove more copies than the list holds', () => {
  const { tallies } = resolveEntries([entry('Forest', 2)], indexOf(forest));
  assert.throws(() => removeCopies(tallies, forest, 3), /cannot remove 3; the list has 2/);
});

test('applyUpgrades makes each swap, keeps the adds apart and leaves the deck untouched', () => {
  const deck = {
    mainboard: [entry('Forest', 2, { role: 'land' }), entry('Example Spell')],
    upgrades: [
      { add: entry('Sol Ring', 1, { role: 'ramp' }), cut: entry('Example Spell'), reason: 'Faster' },
      { add: entry('Example Spell'), cut: entry('Forest'), reason: 'Back in' },
      { add: entry('Arcane Signet', 1, { role: 'ramp' }), cut: entry('Sol Ring'), reason: 'Later cut of an add' },
    ],
  };
  const applied = applyUpgrades(deck);
  assert.deepEqual(applied.mainboard, [entry('Forest', 1, { role: 'land' })]);
  assert.deepEqual(applied.upgradesIn, [entry('Example Spell'), entry('Arcane Signet', 1, { role: 'ramp' })]);
  assert.equal(deck.mainboard[1].quantity, 1);
});

test('applyUpgrades refuses a cut the mainboard cannot cover', () => {
  const deck = {
    mainboard: [entry('Forest')],
    upgrades: [{ add: entry('Sol Ring'), cut: entry('Forest', 2), reason: 'x' }],
  };
  assert.throws(() => applyUpgrades(deck), /cuts 2 Forest, but the mainboard has 1/);
});

test('splitUpgrades moves cut copies, roles included, to swapOut and adds to considering', () => {
  const deck = {
    mainboard: [entry('Forest', 3, { role: 'land' }), entry('Example Spell', 1, { role: 'draw' })],
    upgrades: [
      { add: entry('Sol Ring'), cut: entry('Example Spell'), reason: 'Faster' },
      { add: entry('Wastes'), cut: entry('Forest'), reason: 'Colorless' },
    ],
  };
  const split = splitUpgrades(deck);
  assert.deepEqual(split.mainboard, [entry('Forest', 2, { role: 'land' })]);
  assert.deepEqual(split.swapOut, [entry('Example Spell', 1, { role: 'draw' }), entry('Forest', 1, { role: 'land' })]);
  assert.deepEqual(split.considering, [entry('Sol Ring'), entry('Wastes')]);
  assert.equal(deck.mainboard[0].quantity, 3);
});

test('considered entries need a name and a reason', () => {
  const considered = (items) => stringify(deck({ considered: items }));
  assert.equal(parseDeck(considered([{ name: 'Sol Ring', reason: 'Saved for another deck' }])).considered.length, 1);
  assert.throws(() => parseDeck(considered([{ name: 'Sol Ring' }])), /must have required property 'reason'/);
});
