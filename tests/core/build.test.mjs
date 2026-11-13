import { test } from 'vitest';
import assert from 'node:assert/strict';
import { planBuild, planSwapOut } from '../../src/core/build.mjs';
import { parseTextCollection, resolveTextRows } from '../../src/core/collection.mjs';
import { card, entry, forest, indexOf, row } from './fixtures.mjs';
import * as fixtures from './fixtures.mjs';

// The shared fixtures are all printing TST 1, which text lists can't tell apart.
const leader = { ...fixtures.leader, collectorNumber: '2' };
const spell = { ...fixtures.spell, collectorNumber: '3' };
const spellReprint = card('Example Spell', { id: 'example-spell-reprint', set: 'rpt', collectorNumber: '7' });
const index = indexOf(forest, leader, spell, spellReprint);
const deck = (fields = {}) => ({
  format: 'custom-dollar-brawl',
  unlimited_basics: false,
  commanders: [entry(leader.name)],
  mainboard: [entry(spell.name, 4), entry(forest.name, 55)],
  ...fields,
});
const sourceRow = (value, quantity, extra = {}) => ({ ...row(value, quantity), finish: 'normal', ...extra });
const takenSummary = ({ takes }) => takes.map(({ row: taken, quantity }) => [taken.scryfallId, quantity]);

test('planBuild takes the pinned printing, then the one with most copies, and never proxies', () => {
  const collections = {
    available: [
      sourceRow(leader, 1),
      sourceRow(spell, 1, { position: 0 }),
      sourceRow(spellReprint, 1, { isProxy: true }),
      sourceRow(spellReprint, 3, { position: 1 }),
      sourceRow(spell, 1, { position: 2 }),
      sourceRow(forest, 60),
    ],
  };
  const plan = planBuild(deck(), collections, index);
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(takenSummary(plan), [
    [leader.id, 1],
    [spellReprint.id, 3],
    [spell.id, 1],
    [forest.id, 55],
  ]);
  assert.equal(plan.takes[0].isCommander, true);
  const pinned = deck({ mainboard: [entry(spell.name, 4, { scryfall_id: spell.id }), entry(forest.name, 55)] });
  assert.deepEqual(takenSummary(planBuild(pinned, collections, index)).slice(1, 4), [
    [spell.id, 1],
    [spell.id, 1],
    [spellReprint.id, 2],
  ]);
});

test('planBuild takes nonfoil copies before foil ones, unless a foil printing is pinned', () => {
  const collections = {
    available: [
      sourceRow(leader, 1),
      sourceRow(spellReprint, 3, { finish: 'foil' }),
      sourceRow(spell, 2),
      sourceRow(spell, 1, { finish: 'etched' }),
      sourceRow(forest, 60),
    ],
  };
  assert.deepEqual(takenSummary(planBuild(deck(), collections, index)).slice(1, 4), [
    [spell.id, 2],
    [spellReprint.id, 2],
    [forest.id, 55],
  ]);
  const pinned = deck({ mainboard: [entry(spell.name, 4, { scryfall_id: spellReprint.id }), entry(forest.name, 55)] });
  assert.deepEqual(takenSummary(planBuild(pinned, collections, index)).slice(1, 3), [
    [spellReprint.id, 3],
    [spell.id, 1],
  ]);
});

test('planBuild reports shortfalls, and fills basics from untracked ones only with unlimited_basics', () => {
  const collections = { available: [sourceRow(leader, 1), sourceRow(spell, 4), sourceRow(forest, 50)] };
  assert.deepEqual(planBuild(deck(), collections, index).problems, ['Forest: need 55, 50 non-proxy copies available']);
  const plan = planBuild(deck({ unlimited_basics: true }), collections, index);
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(
    plan.untracked.map(({ card: basic, quantity }) => [basic.name, quantity]),
    [['Forest', 5]],
  );
});

test("planSwapOut takes the pinned printing first from a deck's own list, and untracked basics by name", () => {
  const ownRows = resolveTextRows(
    parseTextCollection('Deck\n1 Example Spell (TST) 3\n2 Example Spell (RPT) 7\n3 Forest\n', 'own'),
    index,
  );
  const cuts = new Map([
    [spell.oracleId, { card: spell, quantity: 2, printingId: spellReprint.id }],
    [forest.oracleId, { card: forest, quantity: 2 }],
  ]);
  const plan = planSwapOut(ownRows, cuts, index);
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(takenSummary(plan), [[spellReprint.id, 2]]);
  assert.deepEqual(
    plan.untracked.map(({ name, quantity }) => [name, quantity]),
    [['Forest', 2]],
  );
  const short = planSwapOut(ownRows, new Map([[leader.oracleId, { card: leader, quantity: 1 }]]), index);
  assert.match(short.problems[0], /Example Leader: the deck's own list has 0 of the 1/);
});
