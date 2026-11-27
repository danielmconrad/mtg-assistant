// The SQL prefilter must never drop a card mtg-manager's search would keep: across many filter
// combinations, every card searchCollection finds among all cards is in the prefilter's result. Also the
// plain text it reads out of regexes, and the paged scan broad searches fall back on.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { searchCollection, searchFilters } from '../../src/core/search.mjs';
import { cardIndexFor, loadMatchingRows, loadOracleIdRows, scanOracleIds } from '../../src/storage/cards.mjs';
import { regexLiterals, searchPrefilter } from '../../src/storage/search-sql.mjs';
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
  scryfallCard('Parhelion II', {
    type_line: 'Legendary Artifact — Vehicle',
    cmc: 8,
    color_identity: ['W'],
    power: '5',
    toughness: '5',
  }),
  scryfallCard('The Eternity Elevator', { type_line: 'Legendary Artifact — Spacecraft', cmc: 5 }),
  scryfallCard("Smuggler's Copter", { type_line: 'Artifact — Vehicle', cmc: 2, power: '3', toughness: '3' }),
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
    { text: ['(graveyard|flying)'] },
    { text: ['add \\{c\\}|charge counters?'] },
    { name: 'lim-d.l|vials?' },
    { type: ['(?:wizards?|background)$'] },
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

  // 1,152 queries, sent 100 at a time; CI's coverage run is several times slower than a local one.
  it('keeps every card mtg-manager’s search finds, for every combination', { timeout: 60_000 }, async () => {
    const combos = combinations();
    const kept = [];
    for (let start = 0; start < combos.length; start += 100) {
      const statements = combos.slice(start, start + 100).map((args) => {
        const filter = searchPrefilter(args);
        return env.DB.prepare(`SELECT name FROM cards c WHERE ${filter.sql}`).bind(...filter.params);
      });
      for (const { results } of await env.DB.batch(statements)) kept.push(new Set(results.map((row) => row.name)));
    }
    let narrowed = 0;
    for (const [position, args] of combos.entries()) {
      const expected = searchCollection(NO_COLLECTIONS, index, searchFilters(asOptions(args), index)).results.map(
        ({ card }) => card.name,
      );
      const missing = expected.filter((name) => !kept[position].has(name));
      expect(missing, JSON.stringify(args)).toEqual([]);
      if (kept[position].size < CARDS.length) narrowed += 1;
    }
    expect(combos).toHaveLength(5 * 3 * 4 * 4 * 12 * 3);
    // It does narrow, too: most combinations leave cards out.
    expect(narrowed / combos.length).toBeGreaterThan(0.9);
  });
});

describe('regexLiterals', () => {
  it.each([
    ['fight', ['fight']],
    ['(fight|deals damage equal to its power)', ['fight', 'deals damage equal to its power']],
    ['(?:draw|investigate)', ['draw', 'investigate']],
    ['create.*token', ['create']],
    ['add \\{C\\}', ['add {C}']],
    ['add {C}', ['add {C}']],
    ['deals \\d+ damage', [' damage']],
    ['creatures? you control', [' you control']],
    ['colou?r', ['colo']],
    ['ab+c', ['ab']],
    ['x{2,}y', ['xy']],
    ['sacrifice (a|another) creature', ['sacrifice ']],
    ['[abc]def', ['def']],
    ['\\bdraw\\b', ['draw']],
    ['Æther', ['ther']],
    ['food|treasure|clue', ['food', 'treasure', 'clue']],
  ])('reads %s as %j', (source, expected) => {
    expect(regexLiterals(source)).toEqual(expected);
  });

  it.each(['x|\\d+', 'Æ', '(?<n>foo)', '(?=foo)', '.*', 'a?', '(a|b)c?'])('gives up on %s', (source) => {
    expect(regexLiterals(source)).toBeNull();
  });

  // Every match contains one of the texts, case aside.
  it('reads only text every match contains', () => {
    const samples = [
      'Deals 3 damage to any target.',
      'Creature you control fights another',
      'add {C}{C}',
      'abbbc colour color',
      'Æther Vial; draw a card',
      'Create a Food token. Sacrifice another creature.',
    ];
    const patterns = [
      'deals \\d+ damage',
      'creatures? you control',
      'add \\{c\\}',
      'ab+c',
      'colou?r',
      'æther|draw',
      'create.*token',
      'sacrifice (a|another) creature',
      'x{0,2}food',
    ];
    for (const source of patterns) {
      const texts = regexLiterals(source);
      for (const sample of samples.filter((candidate) => new RegExp(source, 'i').test(candidate))) {
        expect(
          texts.some((text) => sample.toLowerCase().includes(text.toLowerCase())),
          `${source} on ${sample}`,
        ).toBe(true);
      }
    }
  });
});

describe('scanOracleIds', () => {
  const all = { sql: '1 = 1', params: [] };
  const flying = (row) => /flying/i.test(row.oracle_text);

  it('keeps the cards that pass, across pages', async () => {
    const ids = await scanOracleIds(env.DB, all, flying, { pageSize: 2 });
    const rows = await loadOracleIdRows(env.DB, ids);
    expect(new Set(rows.map((row) => row.name))).toEqual(
      new Set(['Delver of Secrets // Insectile Aberration', "Emeria's Call // Emeria, Shattered Skyclave"]),
    );
  });

  it('applies the SQL filter too, and stops once more than limit match', async () => {
    const green = { sql: '(c.color_identity & ~?) = 0', params: [16] };
    expect(await scanOracleIds(env.DB, green, flying, { pageSize: 2 })).toEqual([]);
    expect(await scanOracleIds(env.DB, all, () => true, { pageSize: 2, limit: 3 })).toHaveLength(4);
  });
});
