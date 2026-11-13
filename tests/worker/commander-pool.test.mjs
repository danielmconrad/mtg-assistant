// Ranking commanders from the ingest's precomputed pool gives exactly what mtg-manager's original
// ranking gives over every card.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrationStatements } from '../../scripts/migrate/plan.mjs';
import { commanderFilters, rankCommanders } from '../../src/core/commanders.mjs';
import {
  cardIndexFor,
  loadCommanderPool,
  loadCommanderRows,
  loadMatchingRows,
  loadOwnedRows,
} from '../../src/storage/cards.mjs';
import { loadCollections } from '../../src/storage/collections.mjs';
import { scryfallCard } from '../fixtures/scryfall.mjs';
import { BUILT, clearCardTables, ingest } from './ingest-helper.mjs';

const creature = (name, type, identity, text = '', extra = {}) =>
  scryfallCard(name, {
    type_line: type,
    color_identity: identity,
    oracle_text: text,
    mana_cost: '{2}',
    cmc: 2,
    ...extra,
  });
const legendary = (name, subtype, identity, text, extra) =>
  creature(name, `Legendary Creature — ${subtype}`, identity, text, extra);

const CARDS = [
  legendary(
    'Elf Lord',
    'Elf Noble',
    ['G'],
    'Other Elves you control get +1/+1. Whenever another Elf you control enters, create a 1/1 green Elf Warrior creature token.',
  ),
  legendary(
    'Dwarf King',
    'Dwarf Noble',
    ['R'],
    'Whenever a Dwarf you control attacks, create a Treasure token. Equipped creatures you control have haste.',
  ),
  legendary(
    'Counter Queen',
    'Human Druid',
    ['G', 'W'],
    'Whenever one or more +1/+1 counters are put on a creature you control, draw a card. Proliferate.',
  ),
  legendary(
    'Food Chef',
    'Halfling',
    ['G', 'B'],
    'Whenever you sacrifice a Food, each opponent loses 1 life. Create a Food token.',
  ),
  legendary(
    'Spider Person',
    'Spider Human Hero',
    ['U', 'R'],
    'Spider Person can block creatures with flying. Other Spiders you control get +1/+1.',
  ),
  legendary(
    'Artifact Tinker',
    'Human Artificer',
    ['U'],
    'Whenever you cast an artifact spell, scry 1. Artifacts you control have hexproof.',
  ),
  legendary('Banned Legend', 'Human', ['B'], 'Whenever a token you control dies, draw a card.', {
    legalities: { commander: 'banned' },
  }),
  scryfallCard('Raised by Giants', {
    type_line: 'Legendary Enchantment — Background',
    color_identity: ['G'],
    oracle_text: 'Commander creatures you own have base power and toughness 10/10. Create a 1/1 Elf token.',
  }),
  creature('Elvish Warrior', 'Creature — Elf Warrior', ['G']),
  creature('Elvish Visionary', 'Creature — Elf Shaman', ['G'], 'When this enters, draw a card.'),
  creature('Changeling Outcast', 'Creature — Shapeshifter', ['B'], 'Changeling', { keywords: ['Changeling'] }),
  creature(
    'Dwarven Forge',
    'Creature — Dwarf Artificer',
    ['R'],
    'Create a Treasure token. Equipment you control cost {1} less.',
  ),
  creature('Counter Bear', 'Creature — Bear', ['G'], 'This enters with a +1/+1 counter on it.'),
  creature('Bakery Elf', 'Creature — Elf Peasant', ['G'], 'When this enters, create a Food token.'),
  creature('Signet Golem', 'Artifact Creature — Golem', [], 'Artifacts you control get +1/+0.'),
  creature('Spider Hatchling', 'Creature — Spider', ['G'], 'Reach. Create a 1/2 green Spider creature token.'),
  scryfallCard('Elven Grove', {
    type_line: 'Land',
    color_identity: ['G'],
    oracle_text: 'Elves you control have hexproof.',
  }),
  scryfallCard('Forest', { type_line: 'Basic Land — Forest', color_identity: ['G'] }),
  scryfallCard('Token Storm', {
    type_line: 'Sorcery',
    color_identity: ['W'],
    oracle_text: 'Create three 1/1 white Soldier creature tokens.',
  }),
];
const OWNED = [
  'Elf Lord',
  'Elvish Warrior',
  'Elvish Visionary',
  'Changeling Outcast',
  'Counter Bear',
  'Bakery Elf',
  'Signet Golem',
  'Elven Grove',
  'Dwarven Forge',
];
const USER = 'user-ranking';

let collections;
let full;
let reduced;
let pool;

beforeAll(async () => {
  await clearCardTables();
  await env.DB.batch(
    ['collection_entries', 'collections', 'decks'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
  await ingest(CARDS);
  const slug = (name) => name.toLowerCase().replace(/\W+/g, '-');
  const rows = OWNED.map((name, position) => ({
    name,
    quantity: 1,
    scryfallId: `${slug(name)}-print`,
    finish: 'normal',
    isProxy: false,
    inDeckBinder: false,
    position,
  }));
  const statements = migrationStatements(
    [
      {
        userId: USER,
        email: 'ranking@example.com',
        existing: true,
        collections: [
          {
            name: 'binder',
            path: 'collections/binder.csv',
            format: 'manabox_csv',
            isProtected: false,
            rows,
            records: [],
          },
        ],
        decks: [],
      },
    ],
    BUILT,
  );
  for (const statement of statements) await env.DB.prepare(statement).run();
  collections = await loadCollections(env.DB, USER);
  full = (await cardIndexFor(env.DB, await loadMatchingRows(env.DB, { sql: '1 = 1' }))).index;
  const commanderRows = await loadCommanderRows(env.DB);
  reduced = (await cardIndexFor(env.DB, [...(await loadOwnedRows(env.DB, USER)), ...commanderRows])).index;
  pool = {
    ...(await loadCommanderPool(env.DB)),
    commanderIds: [...new Set(commanderRows.map((row) => row.oracle_id))],
  };
});

// Each result's scores, rounded so floating-point noise can't differ, and sorted so ties compare equal.
const summary = (ranking) => ({
  considered: ranking.considered,
  unthemed: ranking.unthemed,
  belowMinimum: ranking.belowMinimum,
  results: ranking.results
    .map((result) => ({
      name: result.card.name,
      available: result.available,
      cards: result.cards,
      pool: result.pool,
      expected: result.expected.toFixed(9),
      lift: result.lift === null ? null : result.lift.toFixed(9),
      priceUsd: result.priceUsd,
      themes: result.themes.map(({ name, cards, expected, lift }) => [
        name,
        cards,
        expected.toFixed(9),
        lift === null ? null : lift.toFixed(9),
      ]),
    }))
    .sort((first, second) => (first.name < second.name ? -1 : 1)),
});

describe('the precomputed commander pool', () => {
  it.each([
    [{ 'min-cards': 0 }],
    [{ 'min-cards': 1 }],
    [{ 'min-cards': 0, identity: 'G' }],
    [{ 'min-cards': 0, unowned: true }],
    [{ 'min-cards': 0, theme: 'elf|token' }],
    [{ 'min-cards': 0, sort: 'cards' }],
  ])('ranks exactly as the full card set does, for %j', (options) => {
    const filters = commanderFilters(options);
    const original = summary(rankCommanders(collections, full, filters));
    const precomputed = summary(rankCommanders(collections, reduced, filters, { pool }));
    expect(precomputed).toEqual(original);
    expect(original.results.length + original.unthemed + original.belowMinimum).toBe(original.considered);
  });

  it('actually scores themes and tribes (the fixture is not trivial)', () => {
    const { results } = rankCommanders(collections, full, commanderFilters({ 'min-cards': 1 }));
    const elfLord = results.find((result) => result.card.name === 'Elf Lord');
    expect(elfLord.cards).toBeGreaterThanOrEqual(3);
    expect(elfLord.themes.map(({ name }) => name)).toContain('Elf');
    expect(results.some((result) => result.card.name === 'Banned Legend')).toBe(false);
  });

  it('holds only Commander-legal cards, and marks the candidates', async () => {
    const { results } = await env.DB.prepare(
      'SELECT oracle_id, can_command, is_land FROM commander_pool ORDER BY oracle_id',
    ).all();
    expect(results.find((row) => row.oracle_id === 'banned-legend-oracle')).toBeUndefined();
    expect(results.find((row) => row.oracle_id === 'raised-by-giants-oracle').can_command).toBe(1);
    expect(results.find((row) => row.oracle_id === 'elven-grove-oracle').is_land).toBe(1);
    expect(pool.types).toContain('Elf');
  });
});
