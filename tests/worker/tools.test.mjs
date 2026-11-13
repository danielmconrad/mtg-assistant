// The Milestone 1 tools, called through /mcp as Claude calls them, on fixture cards and a migrated
// collection and deck.
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrationStatements, sourceRecords } from '../../scripts/migrate/plan.mjs';
import { parseCollection, parseTextCollection, resolveTextRows } from '../../src/core/collection.mjs';
import { parseDeck } from '../../src/core/deck.mjs';
import { TOOLS } from '../../src/mcp/tools/index.mjs';
import { cardIndexFor, loadCardRows } from '../../src/storage/cards.mjs';
import { scryfallCard } from '../fixtures/scryfall.mjs';
import { call, mcp, signIn } from './helpers.mjs';
import { clearCardTables, ingest } from './ingest-helper.mjs';

const ID = {
  solRing: '25ef2d44-c261-4511-b96f-85e7a291e318',
  elves: '11111111-1111-4111-8111-111111111111',
  ayula: '22222222-2222-4222-8222-222222222222',
};
const CARDS = [
  scryfallCard('Sol Ring', {
    id: ID.solRing,
    set: 'c21',
    collector_number: '263',
    type_line: 'Artifact',
    mana_cost: '{1}',
    cmc: 1,
    oracle_text: '{T}: Add {C}{C}.',
    game_changer: true,
    edhrec_rank: 1,
    prices: { usd: '1.50' },
  }),
  scryfallCard('Llanowar Elves', {
    id: ID.elves,
    set: 'm19',
    collector_number: '314',
    type_line: 'Creature — Elf Druid',
    mana_cost: '{G}',
    cmc: 1,
    color_identity: ['G'],
    oracle_text: '{T}: Add {G}.',
    edhrec_rank: 50,
  }),
  scryfallCard('Ayula, Queen Among Bears', {
    id: ID.ayula,
    set: 'mh1',
    collector_number: '155',
    type_line: 'Legendary Creature — Bear',
    mana_cost: '{1}{G}',
    cmc: 2,
    color_identity: ['G'],
    oracle_text: 'Whenever another Bear you control enters, choose one —',
    edhrec_rank: 2500,
  }),
  scryfallCard('Forest', {
    type_line: 'Basic Land — Forest',
    color_identity: ['G'],
    produced_mana: ['G'],
    set: 'm19',
    collector_number: '280',
    edhrec_rank: null,
  }),
  scryfallCard('Reanimate', {
    type_line: 'Sorcery',
    mana_cost: '{B}',
    cmc: 1,
    color_identity: ['B'],
    oracle_text: 'Put target creature card from a graveyard onto the battlefield under your control.',
    edhrec_rank: 300,
  }),
  scryfallCard('Lightning Bolt', {
    type_line: 'Instant',
    mana_cost: '{R}',
    cmc: 1,
    color_identity: ['R'],
    oracle_text: 'Lightning Bolt deals 3 damage to any target.',
    edhrec_rank: 20,
    set: 'lea',
    collector_number: '161',
  }),
  scryfallCard('Bearded Bear', {
    type_line: 'Creature — Bear',
    mana_cost: '{1}{G}',
    cmc: 2,
    color_identity: ['G'],
    oracle_text: 'Trample',
    edhrec_rank: 9000,
  }),
];
const CSV =
  'Binder Name,Binder Type,Name,Quantity,Scryfall ID,Set code,Collector number,Foil,Purchase price\n' +
  `all cards,binder,Sol Ring,2,${ID.solRing},C21,263,normal,1.50\n` +
  `all cards,binder,Llanowar Elves,3,${ID.elves},M19,314,normal,0.25\n` +
  `all cards,binder,"Ayula, Queen Among Bears",1,${ID.ayula},MH1,155,foil,4.00\n`;
const PRECON = '1 Reanimate\n1 Missing Card (zzz) 1\n';
const DECK = `schema_version: 1
name: Bears
format: commander
status: draft
allow_proxies: false
unlimited_basics: true
primer: Bears.
commanders:
  - name: Ayula, Queen Among Bears
    quantity: 1
mainboard:
  - name: Sol Ring
    quantity: 1
    role: ramp
  - name: Llanowar Elves
    quantity: 1
    role: ramp
  - name: Forest
    quantity: 97
    role: land
upgrades:
  - add:
      name: Bearded Bear
      quantity: 1
    cut:
      name: Llanowar Elves
      quantity: 1
    reason: More bears.
`;

const OWNER = 'daniel@example.com';
const OTHER = 'second@example.com';
let owner;
let other;

const callTool = async (session, name, args = {}) => {
  const response = await mcp(session.tokens.access_token, 'tools/call', { name, arguments: args });
  const body = await response.json();
  if (body.error) return { error: body.error.message };
  return { text: body.result.content.map((part) => part.text).join('\n'), isError: Boolean(body.result.isError) };
};

beforeAll(async () => {
  await clearCardTables();
  await ingest(CARDS);
});

beforeEach(async () => {
  // setup.mjs empties users before each test, so both people sign in again.
  owner = await signIn(OWNER);
  other = await signIn(OTHER);
  const userId = (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(OWNER).first()).id;
  const { index } = await cardIndexFor(env.DB, await loadCardRows(env.DB, { names: ['Reanimate', 'Missing Card'] }));
  const statements = migrationStatements(
    [
      {
        userId,
        email: OWNER,
        existing: true,
        collections: [
          {
            name: 'ManaBox_Collection',
            path: 'collections/ManaBox_Collection.csv',
            format: 'manabox_csv',
            isProtected: false,
            rows: parseCollection(CSV, 'ManaBox_Collection'),
            records: sourceRecords(CSV),
          },
          {
            name: 'protected/precons/Spooky',
            path: 'collections/protected/precons/Spooky.txt',
            format: 'text',
            isProtected: true,
            rows: resolveTextRows(parseTextCollection(PRECON, 'protected/precons/Spooky'), index),
            records: [],
          },
        ],
        decks: [{ slug: 'bears', deck: parseDeck(DECK) }],
      },
    ],
    '2026-11-13T00:00:00.000Z',
  );
  for (const statement of statements) await env.DB.prepare(statement).run();
});

describe('search_cards', () => {
  it('lists owned cards with copies, protected holdings noted', async () => {
    const { text } = await callTool(owner, 'search_cards', { include_protected: true });
    expect(text).toContain('2x Sol Ring {1} — Artifact [C] [Game Changer]');
    expect(text).toContain('3x Llanowar Elves {G} — Creature — Elf Druid [G]');
    expect(text).toContain('0x Reanimate {B} — Sorcery [B] (+1 in protected/precons/Spooky, protected)');
    expect(text).toMatch(/4 cards$/m);
  });

  it('counts and groups', async () => {
    expect((await callTool(owner, 'search_cards', { count: true })).text).toContain(
      '3 cards, 6 copies in ManaBox_Collection',
    );
    const grouped = (await callTool(owner, 'search_cards', { group_by: 'identity' })).text;
    expect(grouped).toMatch(/^2 +G \(4 copies\)$/m);
  });

  it('filters by identity, commander, text and type', async () => {
    expect((await callTool(owner, 'search_cards', { identity: 'C' })).text).toMatch(/Sol Ring[\s\S]*1 cards/);
    expect(
      (await callTool(owner, 'search_cards', { commander: 'Ayula, Queen Among Bears', type: ['creature'] })).text,
    ).toMatch(/Llanowar Elves[\s\S]*Ayula[\s\S]*2 cards/);
    expect((await callTool(owner, 'search_cards', { text: ['add \\{g\\}'] })).text).toMatch(
      /Llanowar Elves[\s\S]*1 cards/,
    );
    expect((await callTool(owner, 'search_cards', { role: ['ramp'], sort: 'edhrec' })).text).toMatch(
      /Sol Ring[\s\S]*Llanowar Elves/,
    );
  });

  it('searches cards the person does not own, and every card', async () => {
    const unowned = (await callTool(owner, 'search_cards', { scope: 'unowned', identity: 'G' })).text;
    expect(unowned).toContain('Bearded Bear');
    expect(unowned).not.toContain('Llanowar Elves');
    const all = (await callTool(owner, 'search_cards', { scope: 'all', set: ['lea'] })).text;
    expect(all).toContain('0x Lightning Bolt {R} — Instant [R] {lea 161, common}');
  });

  it('says when it shows only some results', async () => {
    expect((await callTool(owner, 'search_cards', { limit: 1 })).text).toMatch(/1 of 3 cards shown/);
  });

  it('refuses unsafe or contradictory searches', async () => {
    expect(await callTool(owner, 'search_cards', { text: ['(a+)+$'] })).toMatchObject({
      isError: true,
      text: expect.stringMatching(/nested quantifier/),
    });
    expect(await callTool(owner, 'search_cards', { name: '(' })).toMatchObject({
      isError: true,
      text: expect.stringMatching(/not a valid regular expression/),
    });
    expect(await callTool(owner, 'search_cards', { count: true, group_by: 'role' })).toMatchObject({ isError: true });
    expect(
      await callTool(owner, 'search_cards', { identity: 'G', commander: 'Ayula, Queen Among Bears' }),
    ).toMatchObject({ isError: true, text: expect.stringMatching(/not both/) });
  });

  it('rejects unknown arguments', async () => {
    const result = await callTool(owner, 'search_cards', { user_id: 'someone-else' });
    expect(result.isError || result.error).toBeTruthy();
  });
});

describe('get_cards', () => {
  it('reports copies and the decks using a card', async () => {
    const { text } = await callTool(owner, 'get_cards', { names: ['Llanowar Elves'] });
    expect(text).toContain('Copies: 3 available');
    expect(text).toMatch(/Decks: .*bears/);
  });

  it('suggests names for misspellings', async () => {
    const { text } = await callTool(owner, 'get_cards', { names: ['Llanowar Elfs', 'Zzzzzzzzzz'] });
    expect(text).toContain('Llanowar Elfs: no card by that name; did you mean Llanowar Elves?');
    expect(text).toContain('Zzzzzzzzzz: no card by that name; check the spelling');
  });
});

describe('collection_summary', () => {
  it('lists collections, protection and unmatched rows', async () => {
    const { text } = await callTool(owner, 'collection_summary');
    expect(text).toMatch(/^Card data: \d+ printings of \d+ cards/m);
    expect(text).toContain('ManaBox_Collection: 3 rows, 6 copies, 3 distinct names, 0 proxy copies');
    expect(text).toContain('protected/precons/Spooky (protected): 2 rows');
    expect(text).toContain('WARNING: protected/precons/Spooky: line 2: Missing Card matches no printing');
  });
});

describe('deck tools', () => {
  it('list, show, stats, check and export a deck', async () => {
    expect((await callTool(owner, 'list_decks')).text).toBe('bears: Bears (commander, draft)');
    expect((await callTool(owner, 'show_deck', { slug: 'bears', role: 'ramp' })).text).toBe(
      [
        'Commander: 1x Ayula, Queen Among Bears {1}{G} — Legendary Creature — Bear',
        'ramp (2)',
        '  1x Llanowar Elves {G} — Creature — Elf Druid [ramp]',
        '  1x Sol Ring {1} — Artifact [ramp]',
      ].join('\n'),
    );
    expect((await callTool(owner, 'deck_stats', { slug: 'bears' })).text).toMatch(/curve/i);
    const check = (await callTool(owner, 'check_deck', { slug: 'bears' })).text;
    expect(check).toBe(
      'PASS: bears (100 cards)\n  NOTE: Bracket 3 or higher by its cards (1 Game Changers: Sol Ring); set target_bracket to enforce',
    );
    const exported = (await callTool(owner, 'export_deck', { slug: 'bears', format: 'moxfield', upgrades: 'apply' }))
      .text;
    expect(exported).toContain('1 Ayula, Queen Among Bears (MH1) 155');
    expect(exported).toContain('Bearded Bear');
    expect(exported).toContain('In Moxfield');
  });

  it('refuses an unknown or malformed slug', async () => {
    expect(await callTool(owner, 'show_deck', { slug: 'nope' })).toMatchObject({
      isError: true,
      text: expect.stringMatching(/No deck named nope/),
    });
    const malformed = await callTool(owner, 'show_deck', { slug: '../etc' });
    expect(malformed.isError || malformed.error).toBeTruthy();
  });
});

// Every tool, called by someone else, sees nothing of the owner's. A new tool fails this until added.
const ISOLATION = {
  search_cards: [{ include_protected: true }, (text) => expect(text).toMatch(/^0 cards$/m)],
  get_cards: [{ names: ['Llanowar Elves'] }, (text) => expect(text).toMatch(/Copies: 0 available[\s\S]*Decks: none/)],
  collection_summary: [{}, (text) => expect(text).toContain('No collections yet.')],
  list_decks: [{}, (text) => expect(text).toBe('No decks yet.')],
  show_deck: [{ slug: 'bears' }, (text) => expect(text).toMatch(/No deck named bears/)],
  deck_stats: [{ slug: 'bears' }, (text) => expect(text).toMatch(/No deck named bears/)],
  check_deck: [{ slug: 'bears' }, (text) => expect(text).toMatch(/No deck named bears/)],
  export_deck: [{ slug: 'bears' }, (text) => expect(text).toMatch(/No deck named bears/)],
};

describe('isolation between people', () => {
  it('covers every tool', () => {
    expect(Object.keys(ISOLATION).sort()).toEqual(TOOLS.map((tool) => tool.name).sort());
  });

  it.each(Object.entries(ISOLATION))('%s shows another person nothing of the owner’s', async (name, [args, check]) => {
    const { text } = await callTool(other, name, args);
    check(text);
    expect(text).not.toMatch(/ManaBox_Collection|Spooky|Bears \(/);
  });
});

describe('/mcp request limits', () => {
  it('refuses bodies over 64 KB', async () => {
    const response = await call('/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${owner.tokens.access_token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_cards', arguments: { names: ['x'.repeat(70_000)] } },
      }),
    });
    expect(response.status).toBe(413);
  });
});
