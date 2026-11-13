// The SQL prefilter must never drop a card mtg-manager's search would keep: across many filter
// combinations, every card searchCollection finds among all cards is in the prefilter's result.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { searchCollection, searchFilters } from '../../src/core/search.mjs';
import { cardIndexFor, loadMatchingRows } from '../../src/storage/cards.mjs';
import { searchPrefilter } from '../../src/storage/search-sql.mjs';
import { scryfallCard } from '../fixtures/scryfall.mjs';
import { clearCardTables, ingest } from './ingest-helper.mjs';

const commander = { commander: 'legal', standard: 'not_legal', oldschool: 'not_legal' };
const CARDS = [
  scryfallCard('Lim-Dûl the Necromancer', {
    type_line: 'Legendary Creature — Human Wizard',
    cmc: 7,
    color_identity: ['B'],
    oracle_text: 'Whenever a creature an opponent controls dies, you may pay {1}{B}.',
    rarity: 'rare',
    set: 'all',
  }),
  scryfallCard('Æther Vial', {
    type_line: 'Artifact',
    cmc: 1,
    oracle_text: 'At the beginning of your upkeep, you may put a charge counter on Æther Vial.',
    game_changer: true,
    set: 'dst',
    rarity: 'uncommon',
  }),
  scryfallCard('Delver of Secrets // Insectile Aberration', {
    type_line: 'Creature — Human Wizard // Creature — Human Insect',
    cmc: 1,
    color_identity: ['U'],
    oracle_text: 'Transform it.\nFlying',
    set: 'isd',
  }),
  scryfallCard("Emeria's Call // Emeria, Shattered Skyclave", {
    type_line: 'Sorcery // Land',
    cmc: 7,
    color_identity: ['W'],
    oracle_text: 'Create two 4/4 white Angel Warrior creature tokens with flying.',
    rarity: 'mythic',
    set: 'znr',
  }),
  scryfallCard('Forest', { type_line: 'Basic Land — Forest', color_identity: ['G'], produced_mana: ['G'] }),
  scryfallCard('Dryad Arbor', { type_line: 'Land Creature — Forest Dryad', color_identity: ['G'] }),
  scryfallCard('Prized Amalgam', {
    type_line: 'Creature — Zombie',
    cmc: 3,
    color_identity: ['U', 'B'],
    oracle_text:
      'Whenever a creature enters, if it entered from your graveyard or you cast it from your graveyard, return this card from your graveyard to the battlefield tapped.',
  }),
  scryfallCard('Wyleth, Soul of Steel', {
    type_line: 'Legendary Creature — Dwarf',
    cmc: 3,
    color_identity: ['R', 'W'],
    oracle_text: 'Trample',
  }),
  scryfallCard('Raised by Giants', {
    type_line: 'Legendary Enchantment — Background',
    cmc: 6,
    color_identity: ['G'],
    oracle_text: 'Commander creatures you own have base power and toughness 10/10.',
  }),
  scryfallCard('Teferi, Temporal Archmage', {
    type_line: 'Legendary Planeswalker — Teferi',
    cmc: 6,
    color_identity: ['U'],
    oracle_text: 'Teferi, Temporal Archmage can be your commander.',
  }),
  scryfallCard('Sol Ring', {
    type_line: 'Artifact',
    cmc: 1,
    oracle_text: '{T}: Add {C}{C}.',
    game_changer: true,
    legalities: { ...commander, vintage: 'restricted' },
  }),
  scryfallCard('Black Lotus', {
    type_line: 'Artifact',
    cmc: 0,
    oracle_text: '{T}, Sacrifice Black Lotus: Add three mana of any one color.',
    legalities: { commander: 'banned', vintage: 'restricted' },
  }),
];

const FILTER_CHOICES = {
  identity: [{}, { identity: 'G' }, { identity: 'UB' }, { identity: 'C' }, { identity: 'WUBRG' }],
  legal: [{}, { legal: 'commander' }, { legal: 'vintage' }],
  mv: [{}, { min_mv: 1 }, { max_mv: 3 }, { min_mv: 6, max_mv: 7 }],
  flags: [{}, { game_changers: true }, { nonland: true }, { commanders_only: true }],
  text: [
    {},
    { name: 'lim-dÛl' },
    { name: 'æther' },
    { type: ['land'] },
    { type: ['creature', 'wizard'] },
    { text: ['graveyard'] },
    { text: ['ADD \\{C\\}'] },
    { text: ['flying'] },
  ],
  printing: [{}, { set: ['ZNR'] }, { rarity: ['mythic', 'rare'] }],
};

// Every combination of one choice per filter, merged into one argument object.
const combinations = () =>
  Object.values(FILTER_CHOICES).reduce(
    (combos, choices) =>
      combos.flatMap((combo) =>
        choices.map((choice) => ({ ...combo, ...(typeof choice === 'object' || choice === undefined ? choice : {}) })),
      ),
    [{}],
  );

const asOptions = (args) => ({
  identity: args.identity,
  legal: args.legal,
  name: args.name,
  type: args.type,
  text: args.text,
  'min-mv': args.min_mv === undefined ? undefined : String(args.min_mv),
  'max-mv': args.max_mv === undefined ? undefined : String(args.max_mv),
  commanders: args.commanders_only,
  nonland: args.nonland,
  'game-changers': args.game_changers,
  set: args.set,
  rarity: args.rarity,
  'all-cards': true,
});

const NO_COLLECTIONS = { available: [], protected: [], availableNames: [], sources: [] };

describe('searchPrefilter', () => {
  let index;
  beforeAll(async () => {
    await clearCardTables();
    await ingest(CARDS);
    ({ index } = await cardIndexFor(env.DB, await loadMatchingRows(env.DB, { sql: '1 = 1' })));
  });

  it('keeps every card mtg-manager’s search finds, for every combination', async () => {
    let checked = 0;
    let narrowed = 0;
    for (const args of combinations()) {
      const expected = searchCollection(NO_COLLECTIONS, index, searchFilters(asOptions(args), index)).results.map(
        ({ card }) => card.name,
      );
      const filter = searchPrefilter(args);
      const { results } = await env.DB.prepare(`SELECT name FROM cards c WHERE ${filter.sql}`)
        .bind(...filter.params)
        .all();
      const kept = new Set(results.map((row) => row.name));
      const missing = expected.filter((name) => !kept.has(name));
      expect(missing, JSON.stringify(args)).toEqual([]);
      checked += 1;
      if (kept.size < CARDS.length) narrowed += 1;
    }
    expect(checked).toBe(5 * 3 * 4 * 4 * 8 * 3);
    // It does narrow, too: most combinations leave cards out.
    expect(narrowed / checked).toBeGreaterThan(0.9);
  });
});
