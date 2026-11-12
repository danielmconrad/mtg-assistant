import { test } from 'vitest';
import assert from 'node:assert/strict';
import { bracketFloor, checkDeck, worstOutcome } from '../../src/core/rules.mjs';
import { DAY_MS, NOW, card, entry, forest, indexOf, leader, messages, row, spell } from './fixtures.mjs';

const owned = () => ({ available: [row(forest, 100), row(leader, 1), row(spell, 4)], protected: [] });
const commanderDeck = (fields = {}) => ({
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
const casualDeck = (mainboard) => commanderDeck({ format: 'casual-60', commanders: [], mainboard });
const check = (deck, { collections = owned(), cards = [forest, leader, spell], now = NOW } = {}) =>
  checkDeck(deck, collections, indexOf(...cards), { now });

test('a legal, owned Commander deck passes', () => {
  const report = check(commanderDeck());
  assert.equal(report.outcome, 'pass');
  assert.equal(report.total, 100);
  assert.deepEqual(report.findings, []);
});

test('Commander deck size counts the commander', () => {
  assert.deepEqual(messages(check(commanderDeck({ mainboard: [entry(forest.name, 98)] })), 'error'), [
    'Commander requires 100 cards including commanders; found 99',
  ]);
});

test('Custom Dollar Brawl needs exactly 60 cards, singleton, within the commander color identity', () => {
  const sixty = (mainboard) => commanderDeck({ format: 'custom-dollar-brawl', mainboard });
  const cheap = { ...spell, prices: { usd: '0.50', eur: null } };
  const cards = [forest, leader, cheap];
  assert.equal(check(sixty([entry(forest.name, 59)]), { cards }).outcome, 'pass');
  assert.deepEqual(messages(check(sixty([entry(forest.name, 60)]), { cards }), 'error'), [
    'Custom Dollar Brawl requires 60 cards including commanders; found 61',
  ]);
  const blue = { ...cheap, colorIdentity: ['U'] };
  const report = check(sixty([entry(forest.name, 57), entry(spell.name, 2)]), { cards: [forest, leader, blue] });
  assert.deepEqual(messages(report, 'error'), [
    'Example Spell: 2 copies exceeds limit 1',
    'Example Spell: outside commander color identity',
  ]);
});

test('Custom Dollar Brawl uses Commander legality and commanders, and caps cards at 1 USD', () => {
  const brawl = (fields) =>
    commanderDeck({ format: 'custom-dollar-brawl', mainboard: [entry(forest.name, 58), entry(spell.name)], ...fields });
  const banned = { ...spell, prices: { usd: '0.50', eur: null }, legalities: { commander: 'banned' } };
  assert.deepEqual(messages(check(brawl(), { cards: [forest, leader, banned] }), 'error'), [
    'Example Spell: banned in Custom Dollar Brawl',
  ]);
  assert.deepEqual(messages(check(brawl()), 'error'), [
    'Example Spell: cheapest printing 2.50 USD exceeds the Custom Dollar Brawl cap 1.00 USD',
  ]);
  assert.equal(check(brawl({ max_card_price: { amount: 3, currency: 'USD' } })).outcome, 'pass');
  const walker = card('Example Walker', { typeLine: 'Legendary Planeswalker — Test', colorIdentity: ['G'] });
  const collections = { available: [row(forest, 100), row(walker, 1)], protected: [] };
  const walkerDeck = brawl({ commanders: [entry(walker.name)], mainboard: [entry(forest.name, 59)] });
  assert.deepEqual(messages(check(walkerDeck, { collections, cards: [forest, walker] }), 'error'), [
    'Example Walker: not an eligible commander',
  ]);
});

test('max_card_price fails cards whose cheapest printing costs more, including upgrade adds', () => {
  const capped = (fields) => commanderDeck({ max_card_price: { amount: 1, currency: 'USD' }, ...fields });
  const cheapPrinting = { ...spell, id: 'spell-cheap', prices: { usd: '0.50', eur: null } };
  const pricey = card('Pricey Spell', { colorIdentity: ['G'], prices: { usd: '3.00', eur: null } });
  const cards = [forest, leader, spell, pricey];
  assert.equal(check(capped()).outcome, 'pass');
  assert.deepEqual(messages(check(capped({ mainboard: [entry(forest.name, 98), entry(spell.name)] })), 'error'), [
    'Example Spell: cheapest printing 2.50 USD exceeds max_card_price 1.00 USD',
  ]);
  const withCheapPrinting = check(capped({ mainboard: [entry(forest.name, 98), entry(spell.name)] }), {
    cards: [forest, leader, spell, cheapPrinting],
  });
  assert.equal(withCheapPrinting.outcome, 'pass');
  const upgrade = { add: entry(pricey.name), cut: entry(forest.name), reason: 'Test' };
  assert.deepEqual(messages(check(capped({ upgrades: [upgrade] }), { cards }), 'error'), [
    'Pricey Spell: cheapest printing 3.00 USD exceeds max_card_price 1.00 USD',
  ]);
});

test('max_card_price is incomplete when a price is unknown', () => {
  const unpriced = { ...leader, prices: { usd: null, eur: null } };
  const report = check(commanderDeck({ max_card_price: { amount: 1, currency: 'USD' } }), {
    cards: [forest, unpriced, spell],
  });
  assert.deepEqual(messages(report, 'incomplete'), ['Example Leader: price cap unchecked; no USD quote on Scryfall']);
});

test('casual decks need at least 60 cards', () => {
  assert.equal(check(casualDeck([entry(forest.name, 60)])).outcome, 'pass');
  assert.deepEqual(messages(check(casualDeck([entry(forest.name, 59)])), 'error'), [
    'Casual requires at least 60 cards; found 59',
  ]);
});

test('cards outside the commander color identity fail', () => {
  const blue = { ...spell, colorIdentity: ['U'] };
  const report = check(commanderDeck({ mainboard: [entry(forest.name, 98), entry(spell.name)] }), {
    cards: [forest, leader, blue],
  });
  assert.deepEqual(messages(report, 'error'), ['Example Spell: outside commander color identity']);
});

test('cards banned in Commander fail', () => {
  const banned = { ...spell, legalities: { commander: 'banned' } };
  const report = check(commanderDeck({ mainboard: [entry(forest.name, 98), entry(spell.name)] }), {
    cards: [forest, leader, banned],
  });
  assert.deepEqual(messages(report, 'error'), ['Example Spell: banned in Commander']);
});

test('a commander that is not a legendary creature fails', () => {
  const plainCreature = { ...leader, typeLine: 'Creature — Elf', frontType: 'Creature — Elf' };
  assert.deepEqual(messages(check(commanderDeck(), { cards: [forest, plainCreature] }), 'error'), [
    'Example Leader: not an eligible commander',
  ]);
});

test('copy limits are one in Commander and four in casual, with basics exempt', () => {
  const twoSpells = commanderDeck({ mainboard: [entry(forest.name, 97), entry(spell.name, 2)] });
  assert.deepEqual(messages(check(twoSpells), 'error'), ['Example Spell: 2 copies exceeds limit 1']);
  assert.deepEqual(messages(check(casualDeck([entry(forest.name, 55), entry(spell.name, 5)])), 'error'), [
    'Example Spell: 5 copies exceeds limit 4',
    'Example Spell: need 5, 4 available (short 1)',
  ]);
});

test('printed copy-limit exceptions are honored', () => {
  const collections = { available: [row(forest, 60), row(spell, 20)], protected: [] };
  const deck = casualDeck([entry(forest.name, 51), entry(spell.name, 9)]);
  const nine = { ...spell, oracleText: 'A deck can have up to nine cards named Example Spell.' };
  const any = { ...spell, oracleText: 'A deck can have any number of cards named Example Spell.' };
  const unusual = { ...spell, oracleText: 'A deck can have only one card named Example Spell per opponent.' };
  assert.equal(check(deck, { collections, cards: [forest, nine] }).outcome, 'pass');
  assert.equal(check(deck, { collections, cards: [forest, any] }).outcome, 'pass');
  assert.deepEqual(messages(check(deck, { collections, cards: [forest, unusual] }), 'incomplete'), [
    'Example Spell: unusual copy-limit text; verify manually',
  ]);
});

test('shortfalls fail and mention protected copies by collection', () => {
  const collections = {
    available: [row(leader, 1)],
    protected: [row(forest, 90, { collection: 'precons' }), row(forest, 9, { collection: 'Cube' })],
  };
  assert.deepEqual(messages(check(commanderDeck(), { collections }), 'error'), [
    'Forest: need 99, 0 available (short 99); 90 in precons, 9 in Cube (protected)',
  ]);
});

test('proxy copies count only when the deck allows proxies', () => {
  const collections = { available: [row(leader, 1), row(forest, 99, { isProxy: true })], protected: [] };
  assert.equal(check(commanderDeck(), { collections }).outcome, 'fail');
  assert.equal(check(commanderDeck({ allow_proxies: true }), { collections }).outcome, 'pass');
});

test('unlimited_basics removes basic land shortfalls', () => {
  const collections = { available: [row(leader, 1)], protected: [] };
  assert.equal(check(commanderDeck({ unlimited_basics: true }), { collections }).outcome, 'pass');
});

test('unknown and ambiguous card names make the check incomplete', () => {
  assert.equal(
    check(commanderDeck({ mainboard: [entry(forest.name, 98), entry('Mystery Card')] })).outcome,
    'incomplete',
  );
  const otherLeader = { ...leader, id: 'other', oracleId: 'other' };
  assert.match(
    messages(check(commanderDeck(), { cards: [forest, leader, otherLeader] }), 'incomplete').join(),
    /ambiguous/,
  );
});

test('card data older than 30 days adds a note without changing the outcome', () => {
  const report = check(commanderDeck(), { now: NOW + 31 * DAY_MS });
  assert.equal(report.outcome, 'pass');
  assert.deepEqual(messages(report, 'note'), [
    'Card data is 31 days old; run scryfall:refresh to pick up recent bans and errata',
  ]);
});

test('failures outrank unknowns when combining outcomes', () => {
  assert.equal(worstOutcome(['pass', 'incomplete', 'fail', 'pass']), 'fail');
  assert.equal(worstOutcome(['pass', 'incomplete']), 'incomplete');
  assert.equal(worstOutcome([]), 'pass');
});

const second = card('Second Leader', { typeLine: 'Legendary Creature — Elf', colorIdentity: ['G'] });
const background = card('Some Background', { typeLine: 'Legendary Enchantment — Background', colorIdentity: ['G'] });
const doctor = {
  ...second,
  typeLine: 'Legendary Creature — Time Lord Doctor',
  frontType: 'Legendary Creature — Time Lord Doctor',
};

function checkPair(first, other) {
  const deck = commanderDeck({
    commanders: [entry(first.name), entry(other.name)],
    mainboard: [entry(forest.name, 98)],
  });
  const collections = { available: [row(forest, 98), row(first, 1), row(other, 1)], protected: [] };
  return check(deck, { collections, cards: [forest, first, other] }).outcome;
}

test('recognized commander pairings pass', () => {
  const pairs = {
    'two plain Partners': [
      { ...leader, oracleText: 'Partner' },
      { ...second, oracleText: 'Partner (You can have two commanders.)' },
    ],
    'Partner with each other': [
      { ...leader, oracleText: 'Partner with Second Leader' },
      { ...second, oracleText: 'Partner with Example Leader' },
    ],
    'Friends forever': [
      { ...leader, keywords: ['Friends forever'] },
      { ...second, keywords: ['Friends forever'] },
    ],
    'Choose a Background': [{ ...leader, keywords: ['Choose a Background'] }, background],
    "Doctor's companion": [{ ...leader, keywords: ["Doctor's companion"] }, doctor],
  };
  for (const [label, [first, other]] of Object.entries(pairs)) assert.equal(checkPair(first, other), 'pass', label);
});

test('unrecognized commander pairings need manual review', () => {
  const pairs = {
    'two plain legends': [leader, second],
    'Partner with someone else': [
      { ...leader, oracleText: 'Partner with Someone Else' },
      { ...second, oracleText: 'Partner' },
    ],
    'Background without Choose a Background': [leader, background],
  };
  for (const [label, [first, other]] of Object.entries(pairs)) {
    assert.equal(checkPair(first, other), 'incomplete', label);
  }
});

const gameChanger = (name) => card(name, { gameChanger: true, colorIdentity: ['G'] });
const changers = ['Changer One', 'Changer Two', 'Changer Three', 'Changer Four'].map(gameChanger);

function checkWithChangers(count, fields = {}) {
  const used = changers.slice(0, count);
  const deck = commanderDeck({
    mainboard: [entry(forest.name, 99 - count), ...used.map((value) => entry(value.name))],
    ...fields,
  });
  const collections = {
    available: [row(forest, 99), row(leader, 1), ...used.map((value) => row(value, 1))],
    protected: [],
  };
  return check(deck, { collections, cards: [forest, leader, ...used] });
}

test('without a target_bracket, the bracket the cards set is a note', () => {
  const report = checkWithChangers(2);
  assert.equal(report.outcome, 'pass');
  assert.deepEqual(messages(report, 'note'), [
    'Bracket 3 or higher by its cards (2 Game Changers: Changer One, Changer Two); set target_bracket to enforce',
  ]);
  assert.deepEqual(messages(checkWithChangers(0), 'note'), []);
});

test('target_bracket fails cards that need a higher bracket', () => {
  assert.equal(checkWithChangers(3, { target_bracket: 3 }).outcome, 'pass');
  assert.deepEqual(messages(checkWithChangers(4, { target_bracket: 3 }), 'error'), [
    'Bracket 4 or higher by its cards (4 Game Changers: Changer One, Changer Two, Changer Three, Changer Four); target_bracket is 3',
  ]);
  assert.match(messages(checkWithChangers(1, { target_bracket: 2 }), 'error').join(), /target_bracket is 2/);
  assert.equal(checkWithChangers(4, { target_bracket: 4 }).outcome, 'pass');
});

test('Bracket 1 Game Changers need a playgroup decision rather than failing', () => {
  const report = checkWithChangers(1, { target_bracket: 1 });
  assert.equal(report.outcome, 'incomplete');
  assert.match(messages(report, 'incomplete').join(), /thematic exception/);
});

test('bracketFloor reads Game Changers, extra turns and mass land denial from the cards', () => {
  const tallies = (...cards) => new Map(cards.map((value) => [value.oracleId, { card: value, quantity: 1 }]));
  const timeWalk = card('Time Walk', { oracleText: 'Take an extra turn after this one.' });
  const armageddon = card('Armageddon', { oracleText: 'Destroy all lands.' });
  const winterOrb = card('Winter Orb', {
    oracleText: "As long as Winter Orb is untapped, players can't untap more than one land during their untap steps.",
  });
  const wrath = card('Wrath', { oracleText: "Destroy all creatures. They can't be regenerated." });
  assert.deepEqual(bracketFloor(tallies(forest, wrath)), { bracket: 1, raises: [] });
  assert.equal(bracketFloor(tallies(timeWalk)).bracket, 2);
  assert.equal(bracketFloor(tallies(timeWalk, changers[0])).bracket, 3);
  assert.deepEqual(
    bracketFloor(tallies(armageddon, winterOrb)).raises.map(({ bracket, reason }) => [bracket, reason]),
    [[4, 'mass land denial: Armageddon, Winter Orb']],
  );
  const report = check(
    commanderDeck({ target_bracket: 1, mainboard: [entry(forest.name, 98), entry(timeWalk.name)] }),
    {
      collections: { available: [row(forest, 98), row(leader, 1), row(timeWalk, 1)], protected: [] },
      cards: [forest, leader, timeWalk],
    },
  );
  assert.deepEqual(messages(report, 'error'), [
    'Bracket 2 or higher by its cards (extra turns: Time Walk); target_bracket is 1',
  ]);
});

test('upgrade adds must keep the deck legal: color identity, legality, copy limits and Game Changers', () => {
  const offColor = card('Off Color', { colorIdentity: ['U'] });
  const changer = card('Changer', { colorIdentity: ['G'], gameChanger: true });
  const cards = [forest, leader, spell, offColor, changer];
  const swap = (add) => ({ add: entry(add), cut: entry(forest.name), reason: 'Test' });
  const deck = commanderDeck({
    target_bracket: 2,
    mainboard: [entry(forest.name, 98), entry(spell.name)],
    upgrades: [swap(offColor.name), swap(spell.name), swap(changer.name)],
  });
  assert.deepEqual(messages(check(deck, { cards }), 'error'), [
    'With upgrades applied: Example Spell: 2 copies exceeds limit 1',
    'With upgrades applied: Off Color: outside commander color identity',
    'With upgrades applied: Bracket 3 or higher by its cards (1 Game Changers: Changer); target_bracket is 2',
  ]);
  const unknown = commanderDeck({ upgrades: [swap('Not Cached')] });
  assert.match(messages(check(unknown), 'incomplete').join(), /With upgrades applied: Not Cached: not in card cache/);
  const badCut = commanderDeck({ upgrades: [{ add: entry(spell.name), cut: entry('Missing'), reason: 'Test' }] });
  assert.match(messages(check(badCut), 'error').join(), /Upgrades: Upgrade cuts 1 Missing/);
  assert.equal(check(commanderDeck({ upgrades: [swap(spell.name)] })).outcome, 'pass');
});

test('role labels outside the vocabulary are noted without changing the outcome', () => {
  const report = check(
    commanderDeck({ mainboard: [entry(forest.name, 98), entry(spell.name, 1, { role: 'ramp, tutor' })] }),
  );
  assert.equal(report.outcome, 'pass');
  assert.deepEqual(messages(report, 'note'), [
    'Role "tutor" isn\'t one of land, ramp, draw, removal, wipe, protection, wincon, synergy: Example Spell',
  ]);
});
