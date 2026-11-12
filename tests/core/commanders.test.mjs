import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  THEMES,
  commanderThemeIndexes,
  commanderTribes,
  creatureTypeVocabulary,
} from '../../src/core/commander-themes.mjs';
import { commanderFilters, rankCommanders } from '../../src/core/commanders.mjs';
import { edhrecFit, edhrecSlug, fetchPage, fetchPages, isStale, parsePage } from '../../src/core/edhrec.mjs';
import { NOW, DAY_MS, card, indexOf, row } from './fixtures.mjs';

const creature = (name, type, fields = {}) =>
  card(name, { typeLine: `Creature — ${type}`, colorIdentity: ['G'], ...fields });
const legend = (name, oracleText, fields = {}) =>
  card(name, { typeLine: 'Legendary Creature — Elf Druid', colorIdentity: ['G'], oracleText, ...fields });

const elfLord = legend('Elf Lord', 'Other Elves you control get +1/+1.');
const lifeLeader = legend('Life Leader', 'Whenever you gain life, put a +1/+1 counter on Life Leader.');
const plainLeader = legend('Plain Leader', 'Trample');
const elves = ['First Elf', 'Second Elf', 'Third Elf'].map((name) => creature(name, 'Elf'));
const bears = ['First Bear', 'Second Bear', 'Third Bear', 'Fourth Bear', 'Fifth Bear', 'Sixth Bear'].map((name) =>
  creature(name, 'Bear'),
);
const healer = card('Healer', { colorIdentity: ['G'], oracleText: 'You gain 3 life.' });
const medic = card('Medic', { colorIdentity: ['G'], oracleText: 'You gain 2 life.' });
const allCards = [elfLord, lifeLeader, plainLeader, ...elves, ...bears, healer, medic];
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
const vocabulary = creatureTypeVocabulary(allCards);

test('a commander cares about the themes its rules text names', () => {
  const themesOf = (oracleText) => commanderThemeIndexes(card('X', { oracleText })).map((at) => THEMES[at].name);
  assert.deepEqual(themesOf('Whenever you gain life, draw a card.'), ['lifegain']);
  assert.deepEqual(themesOf('Whenever you sacrifice a Food, draw a card.'), ['sacrifice', 'food']);
  assert.deepEqual(themesOf('Trample'), []);
  // Each card's themes are kept as bits of one number.
  assert.ok(THEMES.length <= 31);
});

test('tribes are the creature types a commander names, not its own name, tokens it makes or types it excludes', () => {
  const tribesOf = (name, oracleText) => commanderTribes(card(name, { oracleText }), vocabulary);
  assert.deepEqual(tribesOf('A', 'Other Elves you control get +1/+1.'), ['Elf']);
  assert.deepEqual(tribesOf('A', 'Whenever a Bear attacks, draw a card.'), ['Bear']);
  assert.deepEqual(tribesOf('A', 'When A enters, create a 1/1 green Elf creature token.'), []);
  assert.deepEqual(tribesOf('Bear-Man, Hero', 'Bear-Man gets +1/+1.'), []);
  assert.deepEqual(tribesOf('A', 'non-Elf creatures get -1/-1.'), []);
  assert.deepEqual(tribesOf('A', 'Elves and the elf in elves'), ['Elf']);
});

test('the creature type vocabulary leaves out noncreature subtypes that Kindred cards list', () => {
  const kindredSword = card('Kindred Sword', { typeLine: 'Kindred Artifact — Elf Equipment' });
  const sword = card('Sword', { typeLine: 'Artifact — Equipment' });
  const words = creatureTypeVocabulary([kindredSword, sword]);
  assert.equal(words.typeOf('Elves'), 'Elf');
  assert.equal(words.typeOf('Equipment'), undefined);
});

const collectionsOf = (available, protectedRows = []) => ({ available, protected: protectedRows });

test('rankCommanders compares owned on-theme cards with an average collection of the same size', () => {
  const index = indexOf(...allCards);
  // Three elves, a bear and a healer owned: 5 of the 13 spells in the cache besides each commander.
  const owned = [...elves, bears[0], healer].map((value) => row(value, 1));
  const filters = commanderFilters({ 'min-cards': 1 });
  const { results, unthemed } = rankCommanders(collectionsOf(owned), index, filters);
  assert.deepEqual(
    results.map(({ card: value }) => value.name),
    ['Elf Lord', 'Life Leader'],
  );
  const [lord, life] = results;
  assert.equal(lord.cards, 3);
  assert.equal(lord.pool, 5);
  // The cache's 5 other Elves (the two other legends are Elf Druids) would hold 5 x 5/13 at random.
  close(lord.expected, 25 / 13);
  close(lord.lift, 1.56);
  assert.deepEqual(
    lord.themes.map(({ name, cards }) => [name, cards]),
    [['Elf', 3]],
  );
  // One of the cache's two lifegain cards is owned: 1 against 2 x 5/13.
  assert.equal(life.cards, 1);
  close(life.lift, 1.3);
  assert.equal(unthemed, 1);
});

test('rankCommanders filters by ownership, floor, theme and identity, and names the decks a commander leads', () => {
  const index = indexOf(...allCards);
  const owned = [...elves, elfLord].map((value) => row(value, 1));
  const decks = [{ slug: 'brad/elves', deck: { commanders: [{ name: 'Elf Lord', quantity: 1 }] } }];
  const names = (options, protectedRows) =>
    rankCommanders(collectionsOf(owned, protectedRows), index, commanderFilters(options), { decks }).results.map(
      ({ card: value }) => value.name,
    );
  assert.deepEqual(names({ 'min-cards': 3 }), ['Elf Lord']);
  assert.deepEqual(names({ 'min-cards': 3, unowned: true }), []);
  assert.deepEqual(names({ 'min-cards': 0, unowned: true }), ['Life Leader']);
  assert.deepEqual(names({ 'min-cards': 0, theme: 'life' }), ['Life Leader']);
  assert.deepEqual(names({ 'min-cards': 0, identity: 'U' }), []);
  const [lord] = rankCommanders(collectionsOf(owned), index, commanderFilters({}), { decks }).results.filter(
    ({ card: value }) => value.name === 'Elf Lord',
  );
  assert.equal(lord, undefined, 'three elves are under the default floor');
  const [ranked] = rankCommanders(collectionsOf(owned), index, commanderFilters({ 'min-cards': 1 }), { decks }).results;
  assert.deepEqual(ranked.leads, ['brad/elves']);
  assert.equal(ranked.available, 1);
  assert.equal(ranked.cards, 3, 'the commander never counts toward its own theme');
  assert.throws(() => commanderFilters({ owned: true, unowned: true }), /not both/);
});

const page = (cards, decks = 100) => ({
  container: {
    json_dict: {
      card: { name: 'Elf Lord', num_decks: decks },
      cardlists: [
        { tag: 'topcards', cardviews: cards },
        { tag: 'creatures', cardviews: cards.slice(0, 1) },
      ],
    },
  },
});
const view = (name, numDecks, synergy) => ({ name, num_decks: numDecks, potential_decks: 100, synergy });

test('EDHREC slugs drop accents, punctuation and back faces', () => {
  assert.equal(edhrecSlug("Y'shtola, Night's Blessed"), 'yshtola-nights-blessed');
  assert.equal(edhrecSlug('Dáin of the Ancient Halls'), 'dain-of-the-ancient-halls');
  assert.equal(edhrecSlug('Esika, God of the Tree // The Prismatic Bridge'), 'esika-god-of-the-tree');
  assert.equal(edhrecSlug('Ratonhnhaké꞉ton'), 'ratonhnhaketon');
});

test('an EDHREC page becomes the share of its synergy and average deck the collection owns', () => {
  const index = indexOf(...allCards, card('Forest', { typeLine: 'Basic Land — Forest' }));
  const parsed = parsePage(
    page([
      view('First Elf', 80, 0.6),
      view('Second Elf', 20, 0.2),
      view('Healer', 100, -0.1),
      view('Forest', 100, 0),
      view('Not Cached', 50, 0.5),
    ]),
    'elf-lord',
    new Date(NOW).toISOString(),
  );
  assert.equal(parsed.cards.length, 5, 'a card listed twice counts once');
  const owned = {
    counts: new Map([
      [elves[0].oracleId, 1],
      [healer.oracleId, 1],
    ]),
  };
  const fit = edhrecFit(parsed, index, owned);
  assert.equal(fit.listed, 3, 'basics and uncached names are left out');
  assert.equal(fit.owned, 2);
  close(fit.synergyShare, 0.75);
  close(fit.deckShare, 0.9);
  assert.deepEqual(
    fit.topOwned.map(({ name }) => name),
    ['First Elf', 'Healer'],
  );
  assert.throws(() => parsePage({ container: {} }, 'x', ''), /Unexpected EDHREC response for x/);
  assert.deepEqual(edhrecFit({ missing: true, fetchedAt: 'then' }, index, owned), {
    missing: true,
    fetchedAt: 'then',
  });
});

test('fetchPage reads a page, marks one EDHREC lacks as missing, and retries rate limits', async () => {
  const pause = async () => {};
  const requested = [];
  const fetchFn = async (url) => {
    requested.push(url);
    return Response.json(page([view('First Elf', 1, 0.1)]));
  };
  const fetched = await fetchPage('Elf Lord', { fetchFn, pause, now: NOW });
  assert.deepEqual(requested, ['https://json.edhrec.com/pages/commanders/elf-lord.json']);
  assert.equal(fetched.decks, 100);
  const missing = await fetchPage('Nobody', {
    fetchFn: async () => new Response('', { status: 403 }),
    pause,
    now: NOW,
  });
  assert.deepEqual(missing, { slug: 'nobody', fetchedAt: new Date(NOW).toISOString(), missing: true });
  const replies = [new Response('', { status: 429 }), Response.json(page([]))];
  assert.equal((await fetchPage('Elf Lord', { fetchFn: async () => replies.shift(), pause, now: NOW })).decks, 100);
  await assert.rejects(
    fetchPage('Elf Lord', { fetchFn: async () => new Response('', { status: 400 }), pause }),
    /EDHREC returned HTTP 400 for elf-lord/,
  );
  await assert.rejects(
    fetchPage('Elf Lord', {
      fetchFn: async () => {
        throw new Error('fetch failed');
      },
      pause,
    }),
    /EDHREC request failed \(fetch failed\)/,
  );
});

test('fetchPages spaces requests out and hands over each page as it arrives', async () => {
  const pauses = [];
  const pages = [];
  await fetchPages(['Elf Lord', 'Life Leader'], {
    fetchFn: async () => Response.json(page([])),
    pause: async (ms) => pauses.push(ms),
    onPage: (name, fetched, done) => pages.push([name, fetched.slug, done]),
  });
  assert.deepEqual(pauses, [1000]);
  assert.deepEqual(pages, [
    ['Elf Lord', 'elf-lord', 1],
    ['Life Leader', 'life-leader', 2],
  ]);
  assert.equal(isStale({ fetchedAt: new Date(NOW - 31 * DAY_MS).toISOString() }, NOW), true);
  assert.equal(isStale({ fetchedAt: new Date(NOW - DAY_MS).toISOString() }, NOW), false);
  assert.equal(isStale(undefined, NOW), true);
});
