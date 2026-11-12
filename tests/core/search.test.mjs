import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  countResults,
  deckCandidates,
  groupResults,
  parseIdentity,
  searchCollection,
  searchFilters,
  sortResults,
} from '../../src/core/search.mjs';
import { deckListing, deckStats, suggestedLands } from '../../src/core/stats.mjs';
import { identityLabel, orderedIdentity } from '../../src/core/card.mjs';
import { card, entry, forest, indexOf, leader, row, spell } from './fixtures.mjs';

const elf = card('Llanowar Elves', {
  typeLine: 'Creature — Elf Druid',
  manaCost: '{G}',
  manaValue: 1,
  colorIdentity: ['G'],
  oracleText: '{T}: Add {G}.',
});
const ghoul = card('Grave Ghoul', {
  typeLine: 'Creature — Zombie',
  manaCost: '{3}{B}',
  manaValue: 4,
  colorIdentity: ['B'],
  oracleText: 'Return a creature card from your graveyard.',
});
const banned = card('Banned Thing', { typeLine: 'Artifact', manaValue: 1, legalities: { commander: 'banned' } });
const index = indexOf(forest, leader, spell, elf, ghoul, banned);
const collections = {
  available: [row(elf, 2), row(ghoul, 1), row(banned, 1), row(spell, 1)],
  protected: [
    row(elf, 2, { collection: 'precons' }),
    row(elf, 1, { collection: 'Cube' }),
    row(leader, 1, { collection: 'precons' }),
  ],
};
const namesFor = (options) =>
  searchCollection(collections, index, searchFilters(options, index)).results.map((result) => result.card.name);

test('results are sorted by mana value, then name', () => {
  assert.deepEqual(namesFor({}), ['Banned Thing', 'Llanowar Elves', 'Example Spell', 'Grave Ghoul']);
});

test('--identity limits results to a color identity, with C meaning colorless only', () => {
  assert.deepEqual(namesFor({ identity: 'g' }), ['Banned Thing', 'Llanowar Elves', 'Example Spell']);
  assert.deepEqual(namesFor({ identity: 'C' }), ['Banned Thing']);
  assert.throws(() => parseIdentity('GX'), /must use/);
});

test('--type and --text are case-insensitive patterns that must all match', () => {
  assert.deepEqual(namesFor({ type: ['CREATURE'] }), ['Llanowar Elves', 'Grave Ghoul']);
  assert.deepEqual(namesFor({ type: ['creature'], text: ['graveyard'] }), ['Grave Ghoul']);
});

test('mana value bounds are inclusive and must be numbers', () => {
  assert.deepEqual(namesFor({ 'min-mv': '2', 'max-mv': '3' }), ['Example Spell']);
  assert.throws(() => namesFor({ 'max-mv': 'three' }), /--max-mv must be a number/);
});

test('--commander applies the commander color identity and Commander legality', () => {
  assert.deepEqual(namesFor({ commander: 'Example Leader' }), ['Llanowar Elves', 'Example Spell']);
  assert.throws(() => namesFor({ commander: 'Example Leader', identity: 'G' }), /not both/);
  assert.throws(() => namesFor({ commander: 'Nobody' }), /not in card cache/);
});

test('results show protected copies by collection; protected-only cards need --include-protected', () => {
  const [elves] = searchCollection(collections, index, searchFilters({ name: 'elves' }, index)).results;
  assert.deepEqual([elves.available, elves.protected], [2, 3]);
  assert.deepEqual(elves.protectedIn, [
    { name: 'precons', copies: 2 },
    { name: 'Cube', copies: 1 },
  ]);
  assert.ok(!namesFor({}).includes(leader.name));
  assert.ok(namesFor({ 'include-protected': true }).includes(leader.name));
});

test('deckStats summarizes the mainboard curve, types, pips, land sources and roles', () => {
  const deck = {
    commanders: [entry(leader.name)],
    mainboard: [
      entry(forest.name, 30, { role: 'land' }),
      entry(elf.name, 1, { role: 'ramp, creature' }),
      entry(ghoul.name, 2),
    ],
  };
  const stats = deckStats(deck, index);
  assert.equal(stats.cards, 33);
  assert.equal(stats.lands, 30);
  assert.equal(stats.nonlandManaValue, 9);
  assert.deepEqual(Object.fromEntries(stats.curve), { 1: 1, 4: 2 });
  assert.deepEqual(Object.fromEntries(stats.types), { Creature: 3, Land: 30 });
  assert.deepEqual(Object.fromEntries(stats.pips), { G: 1, B: 2 });
  assert.deepEqual(Object.fromEntries(stats.landSources), { G: 30 });
  assert.deepEqual(Object.fromEntries(stats.roles), { land: 30, ramp: 1, creature: 1 });
});

test("deckStats counts only the land colors a commander deck can make, within the commanders' identity", () => {
  const tower = card('Command Tower', { typeLine: 'Land', producedMana: ['W', 'U', 'B', 'R', 'G'] });
  const towerIndex = indexOf(forest, leader, tower);
  const deck = { commanders: [entry(leader.name)], mainboard: [entry(forest.name, 2), entry(tower.name)] };
  const sources = (fields) => Object.fromEntries(deckStats({ ...deck, ...fields }, towerIndex).landSources);
  assert.deepEqual(sources({ format: 'commander' }), { G: 3 });
  assert.deepEqual(sources({ format: 'casual-60', commanders: [] }), { W: 1, U: 1, B: 1, R: 1, G: 3 });
});

test('deckStats reports cards it cannot resolve', () => {
  assert.match(
    deckStats({ commanders: [], mainboard: [entry('Unknown Card')] }, index).problems.join(),
    /Unknown Card/,
  );
});

const background = card('Some Background', { typeLine: 'Legendary Enchantment — Background', colorIdentity: ['W'] });
const planeswalker = card('Lead Walker', {
  typeLine: 'Legendary Planeswalker — Teyo',
  colorIdentity: ['W', 'U'],
  oracleText: 'Lead Walker can be your commander.',
});
const kindred = card('Elf Rite', { typeLine: 'Kindred Instant — Elf', colorIdentity: ['G'] });
const groupIndex = indexOf(leader, elf, ghoul, banned, background, planeswalker, kindred);
const groupCollections = {
  available: [
    row(leader, 1),
    row(elf, 2),
    row(ghoul, 1),
    row(banned, 1),
    row(background, 1),
    row(planeswalker, 1),
    row(kindred, 3),
  ],
  protected: [],
};
const search = (options) => searchCollection(groupCollections, groupIndex, searchFilters(options, groupIndex)).results;

test('--commanders keeps legendary creatures, Backgrounds and "can be your commander" cards', () => {
  assert.deepEqual(
    search({ commanders: true }).map((result) => result.card.name),
    ['Lead Walker', 'Some Background', 'Example Leader'],
  );
});

test('countResults counts distinct cards and available copies', () => {
  assert.deepEqual(countResults(search({ type: ['creature'] })), { cards: 3, copies: 4 });
});

test('grouping by identity uses WUBRG order and C for colorless', () => {
  assert.deepEqual(groupResults(search({}), 'identity'), [
    { key: 'G', cards: 3, copies: 6 },
    { key: 'B', cards: 1, copies: 1 },
    { key: 'C', cards: 1, copies: 1 },
    { key: 'W', cards: 1, copies: 1 },
    { key: 'WU', cards: 1, copies: 1 },
  ]);
});

test('grouping by creature type counts each card once per type, including Kindred', () => {
  assert.deepEqual(
    groupResults(search({}), 'creature-type').map(({ key, cards }) => [key, cards]),
    [
      ['Elf', 3],
      ['Druid', 1],
      ['Zombie', 1],
    ],
  );
});

test('unknown --group-by keys are rejected with the valid choices', () => {
  assert.throws(() => groupResults([], 'artist'), /identity, creature-type/);
});

test('--nonland drops lands', () => {
  const land = card('Some Land', { typeLine: 'Land', oracleText: '{T}: Add {C}.' });
  const index = indexOf(land, elf);
  const owned = { available: [row(land, 1), row(elf, 1)], protected: [] };
  const names = (options) =>
    searchCollection(owned, index, searchFilters(options, index)).results.map((result) => result.card.name);
  assert.deepEqual(names({ text: ['add \\{'] }), ['Some Land', 'Llanowar Elves']);
  assert.deepEqual(names({ text: ['add \\{'], nonland: true }), ['Llanowar Elves']);
});

test('identity helpers order colors WUBRG regardless of Scryfall order', () => {
  const golgari = card('Golgari Card', { colorIdentity: ['G', 'B'] });
  assert.deepEqual(orderedIdentity(golgari), ['B', 'G']);
  assert.equal(identityLabel(golgari), 'BG');
  assert.equal(identityLabel(card('Colorless Card')), 'C');
});

test('--game-changers keeps only Game Changers', () => {
  const study = card('Study Card', { gameChanger: true });
  const index = indexOf(study, elf);
  const owned = { available: [row(study, 1), row(elf, 1)], protected: [] };
  const { results } = searchCollection(owned, index, searchFilters({ 'game-changers': true }, index));
  assert.deepEqual(
    results.map((result) => result.card.name),
    ['Study Card'],
  );
});

test("suggestedLands matches Karsten's worked examples", () => {
  const commander = (averageManaValue, cheapRampAndDraw) =>
    suggestedLands({ format: 'commander', commanderCount: 1, averageManaValue, cheapRampAndDraw });
  assert.equal(commander(3.51, 13).toFixed(1), '38.8');
  assert.equal(commander(3.0, 10).toFixed(1), '38.0');
  const casual = suggestedLands({ format: 'casual-60', commanderCount: 0, averageManaValue: 2.5, cheapRampAndDraw: 4 });
  assert.equal(casual.toFixed(2), '23.22');
  const sixty = suggestedLands({
    format: 'custom-dollar-brawl',
    commanderCount: 1,
    averageManaValue: 3,
    cheapRampAndDraw: 10,
  });
  assert.equal(sixty.toFixed(2), ((59 / 60) * (19.59 + 5.7 + 0.27) - 2.8 - 1.35).toFixed(2));
});

test('deckStats counts cheap ramp and draw by role and mana value, then suggests lands', () => {
  const signet = card('Cheap Rock', { typeLine: 'Artifact', manaValue: 2, manaCost: '{2}' });
  const bigDraw = card('Big Draw', { manaValue: 5, manaCost: '{4}{U}' });
  const index = indexOf(forest, signet, bigDraw, elf);
  const deck = {
    format: 'commander',
    commanders: [entry(leader.name)],
    mainboard: [
      entry(forest.name, 37, { role: 'land' }),
      entry(signet.name, 1, { role: 'ramp' }),
      entry(elf.name, 1, { role: 'ramp, synergy' }),
      entry(bigDraw.name, 1, { role: 'draw' }),
    ],
  };
  const stats = deckStats(deck, index);
  assert.equal(stats.cheapRampAndDraw, 2);
  assert.equal(stats.averageManaValue.toFixed(2), '2.67');
  assert.equal(
    stats.suggestedLands.toFixed(2),
    suggestedLands({ format: 'commander', commanderCount: 1, averageManaValue: 8 / 3, cheapRampAndDraw: 2 }).toFixed(2),
  );
});

test('sortResults orders by EDHREC rank or by price, highest first, with unknown values last', () => {
  const ranked = card('Ranked', { edhrecRank: 10, prices: { usd: '0.10', eur: null } });
  const popular = card('Popular', { edhrecRank: 2, prices: { usd: null, eur: null } });
  const pricey = card('Pricey', { prices: { usd: '30.00', eur: null } });
  const reprint = card('Pricey', { id: 'pricey-reprint', prices: { usd: '12.50', eur: null } });
  const valueIndex = indexOf(ranked, popular, pricey, reprint);
  const { results } = searchCollection(
    { available: [row(ranked, 1), row(popular, 1), row(pricey, 1)], protected: [] },
    valueIndex,
  );
  const names = (by) => sortResults(results, by).map((result) => result.card.name);
  assert.deepEqual(names('edhrec'), ['Popular', 'Ranked', 'Pricey']);
  assert.deepEqual(names('price'), ['Pricey', 'Ranked', 'Popular']);
  assert.equal(results.find((result) => result.card.name === 'Pricey').priceUsd, 12.5);
  assert.throws(() => sortResults(results, 'rarity'), /--sort must be one of: mv, edhrec, price/);
});

test('deckCandidates lists playable cards the deck leaves out, with their considered reasons', () => {
  const pool = {
    available: [row(elf, 2), row(ghoul, 1), row(banned, 1), row(spell, 1), row(forest, 5), row(leader, 1)],
    protected: [],
  };
  const deck = {
    format: 'commander',
    commanders: [entry(leader.name)],
    mainboard: [entry(spell.name)],
    considered: [
      { name: 'Llanowar Elves', reason: 'Too slow here' },
      { name: 'Not Cached', reason: 'x' },
    ],
  };
  const { results } = deckCandidates(deck, pool, index);
  assert.deepEqual(
    results.map((result) => [result.card.name, result.considered]),
    [['Llanowar Elves', 'Too slow here']],
  );
  const withLands = deckCandidates(deck, pool, index, { lands: true }).results.map((result) => result.card.name);
  assert.deepEqual(withLands.toSorted(), ['Forest', 'Llanowar Elves']);
  const capped = deckCandidates({ ...deck, max_card_price: { amount: 0.5, currency: 'USD' } }, pool, index);
  assert.deepEqual([capped.results.length, capped.overCap], [0, 1]);
  const casual = deckCandidates({ ...deck, format: 'casual-60', commanders: [] }, pool, index).results;
  assert.deepEqual(casual.map((result) => result.card.name).toSorted(), [
    'Banned Thing',
    'Example Leader',
    'Grave Ghoul',
    'Llanowar Elves',
  ]);
});

test('--role presets match rules text, and group-by role counts each card once per role', () => {
  const wrath = card('Wrath', { oracleText: 'Destroy all creatures.' });
  const bolt = card('Bolt', { oracleText: 'Bolt deals 3 damage to any target.' });
  const growth = card('Growth', { oracleText: 'Search your library for a basic land card. Draw a card.' });
  const bear = card('Bear', { typeLine: 'Creature — Bear' });
  const roleIndex = indexOf(forest, wrath, bolt, growth, bear);
  const pool = { available: [forest, wrath, bolt, growth, bear].map((value) => row(value, 1)), protected: [] };
  const names = (options) =>
    searchCollection(pool, roleIndex, searchFilters(options, roleIndex)).results.map((result) => result.card.name);
  assert.deepEqual(names({ role: ['wipe'] }), ['Wrath']);
  assert.deepEqual(names({ role: ['removal'] }), ['Bolt']);
  assert.deepEqual(names({ role: ['ramp', 'draw'] }), ['Growth']);
  assert.throws(() => names({ role: ['wincon'] }), /--role must be one of: ramp, draw, removal, wipe, protection/);
  const { results } = searchCollection(pool, roleIndex);
  assert.deepEqual(
    groupResults(results, 'role').map(({ key, cards }) => [key, cards]),
    [
      ['draw', 1],
      ['land', 1],
      ['other', 1],
      ['ramp', 1],
      ['removal', 1],
      ['wipe', 1],
    ],
  );
});

test('--max-price keeps cards at or under a USD price, and --min-copies needs that many available', () => {
  assert.deepEqual(namesFor({ 'max-price': '1' }), ['Banned Thing', 'Llanowar Elves', 'Grave Ghoul']);
  assert.deepEqual(namesFor({ 'min-copies': '2' }), ['Llanowar Elves']);
  assert.throws(() => namesFor({ 'max-price': 'cheap' }), /--max-price must be a number/);
});

test('--unowned searches every playable cached card without an available copy', () => {
  const token = card('Elf Token', { typeLine: 'Token Creature — Elf', legalities: {} });
  const unownedIndex = indexOf(forest, leader, spell, elf, ghoul, banned, token);
  const results = searchCollection(collections, unownedIndex, { unowned: true }).results;
  assert.deepEqual(
    results.map((result) => [result.card.name, result.available, result.protected]),
    [
      ['Forest', 0, 0],
      ['Example Leader', 0, 1],
    ],
  );
  assert.throws(() => searchFilters({ unowned: true, 'min-copies': '1' }, index), /not both/);
});

test('deckStats compares roles with the Command Zone template or role_targets, and gives opening-hand odds', () => {
  const deck = {
    format: 'commander',
    commanders: [entry(leader.name)],
    mainboard: [entry(forest.name, 37, { role: 'land' }), entry(elf.name, 11, { role: 'ramp' })],
  };
  const stats = deckStats(deck, index);
  assert.equal(stats.roleTargets.source, 'Command Zone template');
  assert.deepEqual(
    stats.roleTargets.targets.map(({ role, count, status }) => [role, count, status]),
    [
      ['ramp', 11, 'within'],
      ['draw', 0, 'under'],
      ['removal', 0, 'under'],
      ['wipe', 0, 'under'],
    ],
  );
  const own = deckStats({ ...deck, format: 'casual-60', role_targets: { ramp: { min: 4, max: 8 } } }, index);
  assert.deepEqual(own.roleTargets, {
    source: 'role_targets',
    targets: [{ role: 'ramp', count: 11, min: 4, max: 8, status: 'over' }],
  });
  assert.equal(deckStats({ ...deck, format: 'casual-60' }, index).roleTargets.source, null);
  const { fewLands, keepableLands, manyLands, someRamp } = stats.openingHand;
  assert.ok(Math.abs(fewLands + keepableLands + manyLands - 1) < 1e-9);
  assert.ok(fewLands < 0.01 && manyLands > keepableLands);
  // No ramp in 7 of 48 cards with 11 ramp: (37/48)(36/47)...(31/42).
  const noRamp = Array.from({ length: 7 }, (_, drawn) => (37 - drawn) / (48 - drawn)).reduce((a, b) => a * b);
  assert.ok(Math.abs(someRamp - (1 - noRamp)) < 1e-9);
});

test('deckListing groups the mainboard by first role, marking upgrades and filtering by role', () => {
  const deck = {
    commanders: [entry(leader.name)],
    mainboard: [
      entry(ghoul.name),
      entry(forest.name, 2, { role: 'land' }),
      entry(elf.name, 1, { role: 'synergy, ramp' }),
    ],
    upgradesIn: [entry(spell.name, 1, { role: 'ramp' })],
  };
  const listing = deckListing(deck, index);
  assert.deepEqual(
    listing.groups.map(({ role, items }) => [role, items.map(({ card, upgrade }) => [card.name, upgrade])]),
    [
      ['land', [['Forest', false]]],
      ['ramp', [['Example Spell', true]]],
      ['synergy', [['Llanowar Elves', false]]],
      ['no role', [['Grave Ghoul', false]]],
    ],
  );
  const ramp = deckListing(deck, index, { role: 'ramp' }).groups.flatMap(({ items }) =>
    items.map(({ card }) => card.name),
  );
  assert.deepEqual(ramp, ['Example Spell', 'Llanowar Elves']);
  assert.deepEqual(deckListing({ ...deck, mainboard: [entry('Nope')] }, index).problems, [
    'Nope: not in card cache; check the spelling or run scryfall:refresh -- --missing',
  ]);
});

test('a name the cache lacks gets close suggestions, and refresh advice only without bulk data', () => {
  const sol = card('Sol Ring');
  const swords = card('Swords to Plowshares');
  const lookupProblem = (cards, name) => indexOf(...cards).lookup({ name }).problem;
  assert.equal(
    lookupProblem([sol, swords], 'Sol Rng'),
    'Sol Rng: not in card cache; did you mean Sol Ring? If not, run scryfall:refresh -- --missing',
  );
  assert.equal(
    lookupProblem([{ ...sol, defaultPrinting: true }, swords], 'swords to plowshare'),
    'swords to plowshare: not in card cache; did you mean Swords to Plowshares?',
  );
  assert.equal(
    lookupProblem([{ ...sol, defaultPrinting: true }], 'Qwxzv'),
    'Qwxzv: not in card cache; check the spelling',
  );
});

test('--set and --rarity match a printing, and --all-cards searches every card owned or not', () => {
  const common = card('Set Common', { set: 'trk', rarity: 'common', collectorNumber: '10', manaValue: 1 });
  const rarePrint = card('Set Rare', { set: 'trk', rarity: 'rare', collectorNumber: '20', manaValue: 2 });
  const reprint = card('Llanowar Elves', {
    ...elf,
    id: 'llanowar-elves-trk',
    set: 'trk',
    collectorNumber: '30',
    rarity: 'uncommon',
  });
  const elsewhere = card('Other Set Card', { set: 'abc', rarity: 'common' });
  const setIndex = indexOf(
    forest,
    leader,
    spell,
    { ...elf, rarity: 'common' },
    ghoul,
    common,
    rarePrint,
    reprint,
    elsewhere,
  );
  const search = (options) => searchCollection(collections, setIndex, searchFilters(options, setIndex)).results;
  const names = (options) => search(options).map((result) => result.card.name);

  assert.deepEqual(names({ set: ['TRK'] }), ['Llanowar Elves'], 'owned cards printed in the set');
  assert.deepEqual(names({ 'all-cards': true, set: ['trk'] }), ['Llanowar Elves', 'Set Common', 'Set Rare']);
  assert.deepEqual(names({ 'all-cards': true, set: ['trk,abc'], rarity: ['common'] }), [
    'Other Set Card',
    'Set Common',
  ]);
  assert.deepEqual(names({ 'all-cards': true, set: ['trk'], rarity: ['uncommon', 'rare'] }), [
    'Llanowar Elves',
    'Set Rare',
  ]);
  // The rarity is the printing's in the set, not another printing's.
  const elves = search({ 'all-cards': true, set: ['trk'], name: 'Elves' })[0];
  assert.equal(elves.printing.rarity, 'uncommon');
  assert.equal(elves.available, 2);
  assert.deepEqual(groupResults(search({ 'all-cards': true, set: ['trk'] }), 'rarity'), [
    { key: 'common', cards: 1, copies: 0 },
    { key: 'rare', cards: 1, copies: 0 },
    { key: 'uncommon', cards: 1, copies: 2 },
  ]);
  assert.throws(() => searchFilters({ rarity: ['legendary'] }, setIndex), /--rarity must be one of/);
  assert.throws(() => searchFilters({ unowned: true, 'all-cards': true }, setIndex), /not both/);
});
