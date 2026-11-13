import { test } from 'vitest';
import assert from 'node:assert/strict';
import { cheapestPrice, cheapestQuote, upgradeReport } from '../../src/core/upgrades.mjs';
import { DAY_MS, NOW, card, entry, forest, indexOf, leader, row, spell } from './fixtures.mjs';

const index = indexOf(forest, leader, spell);
const deck = (fields = {}) => ({
  schema_version: 1,
  name: 'Fixture',
  format: 'commander',
  status: 'draft',
  allow_proxies: false,
  primer: 'Test',
  commanders: [entry(leader.name)],
  mainboard: [entry(forest.name, 99)],
  budget: { amount: 3, currency: 'USD' },
  ...fields,
});
const swapSpellForForest = { add: entry(spell.name), cut: entry(forest.name), reason: 'Interaction' };
const withoutSpell = { available: [row(forest, 100), row(leader, 1)], protected: [] };
const report = (value, collections = withoutSpell, now = NOW) => upgradeReport(value, collections, index, { now });
const purchased = ({ purchases }) =>
  purchases.map(({ card: value, quantity, unitCents }) => [value.name, quantity, unitCents]);

test('cheapestQuote picks the cheapest fresh printing', () => {
  const printings = [
    card('Bolt', { id: 'promo', prices: { usd: '40.00', eur: null } }),
    card('Bolt', { id: 'unpriced', prices: { usd: null, eur: null } }),
    card('Bolt', { id: 'cheap', prices: { usd: '0.25', eur: null } }),
  ];
  const quote = cheapestQuote(indexOf(...printings), { card: printings[0] }, { currency: 'USD', now: NOW });
  assert.equal(quote.printing.id, 'cheap');
  assert.equal(quote.unitCents, 25);
});

test('gold-bordered and memorabilia printings never set the price, unless they are the only ones', () => {
  const gold = card('Bolt', { id: 'gold', borderColor: 'gold', prices: { usd: '0.10', eur: null } });
  const memorabilia = card('Bolt', { id: 'ce', setType: 'memorabilia', prices: { usd: '0.05', eur: null } });
  const real = card('Bolt', { id: 'real', prices: { usd: '2.00', eur: null } });
  const quote = (...printings) =>
    cheapestQuote(indexOf(...printings), { card: printings[0] }, { currency: 'USD', now: NOW });
  assert.equal(quote(gold, memorabilia, real).printing.id, 'real');
  assert.equal(cheapestPrice(indexOf(gold, memorabilia, real), real), 2);
  assert.equal(quote(gold).printing.id, 'gold');
});

test('cheapestQuote honors a pinned printing', () => {
  const promo = card('Bolt', { id: 'promo', prices: { usd: '40.00', eur: null } });
  const quotes = indexOf(promo, card('Bolt', { id: 'cheap', prices: { usd: '0.25', eur: null } }));
  assert.equal(
    cheapestQuote(quotes, { card: promo, printingId: 'promo' }, { currency: 'USD', now: NOW }).unitCents,
    4000,
  );
});

test('cheapestQuote reports missing currencies and stale prices instead of guessing', () => {
  assert.equal(
    cheapestQuote(index, { card: spell }, { currency: 'EUR', now: NOW }).problem,
    'no EUR quote on Scryfall',
  );
  assert.match(
    cheapestQuote(index, { card: spell }, { currency: 'USD', now: NOW + 8 * DAY_MS }).problem,
    /older than 7 days/,
  );
});

test('owned spare copies make an upgrade free', () => {
  const owned = { available: [...withoutSpell.available, row(spell, 1)], protected: [] };
  const result = report(deck({ upgrades: [swapSpellForForest] }), owned);
  assert.deepEqual(result.purchases, []);
  assert.equal(result.outcome, 'pass');
});

test('missing upgrade cards are priced against the budget', () => {
  assert.deepEqual(purchased(report(deck({ upgrades: [swapSpellForForest] }))), [['Example Spell', 1, 250]]);
  assert.equal(report(deck({ upgrades: [swapSpellForForest] })).outcome, 'pass');
  assert.equal(
    report(deck({ upgrades: [swapSpellForForest], budget: { amount: 2, currency: 'USD' } })).outcome,
    'fail',
  );
});

test('upgradeReport never mutates the deck', () => {
  const value = deck({ upgrades: [swapSpellForForest] });
  const original = structuredClone(value);
  report(value);
  assert.deepEqual(value, original);
});

test('baseline basic land shortfalls are priced unless basics are unlimited', () => {
  const fewBasics = { available: [row(forest, 10), row(leader, 1)], protected: [] };
  assert.deepEqual(purchased(report(deck({ budget: { amount: 30, currency: 'USD' } }), fewBasics)), [
    ['Forest', 89, 20],
  ]);
  assert.deepEqual(report(deck({ unlimited_basics: true }), fewBasics).purchases, []);
});

test('unknown prices make the report incomplete, never zero-cost', () => {
  const stale = report(deck({ upgrades: [swapSpellForForest] }), withoutSpell, NOW + 8 * DAY_MS);
  assert.equal(stale.outcome, 'incomplete');
  assert.equal(stale.totalCents, 0);
});

test('unbalanced swaps and over-cuts are rejected as input errors', () => {
  const swap = (add, cut) => deck({ upgrades: [{ add, cut, reason: 'Test' }] });
  assert.throws(() => report(swap(entry(spell.name, 2), entry(forest.name, 1))), /quantities must match/);
  assert.throws(() => report(swap(entry(spell.name, 100), entry(forest.name, 100))), /cannot remove 100/);
  assert.throws(() => report(swap(entry(spell.name), entry(leader.name))), /cannot remove 1; the list has 0/);
});

test('swaps naming uncached cards are reported as problems', () => {
  const result = report(deck({ upgrades: [{ add: entry('Mystery Card'), cut: entry(forest.name), reason: 'Test' }] }));
  assert.equal(result.outcome, 'incomplete');
  assert.match(result.problems.join(), /Mystery Card: not in card cache/);
});
