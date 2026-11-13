// The fixture the tool tests share: a few cards, and one person's migrated ManaBox collection, protected
// precon and deck, plus a second person who has nothing. Each test starts from a fresh sign-in.
import { env } from 'cloudflare:test';
import { migrationStatements, sourceRecords } from '../../scripts/migrate/plan.mjs';
import { parseCollection, parseTextCollection, resolveTextRows } from '../../src/core/collection.mjs';
import { parseDeck } from '../../src/core/deck.mjs';
import { cardIndexFor, loadCardRows } from '../../src/storage/cards.mjs';
import { scryfallCard } from '../fixtures/scryfall.mjs';
import { mcp, signIn } from './helpers.mjs';
import { clearCardTables, ingest } from './ingest-helper.mjs';

export const ID = {
  solRing: '25ef2d44-c261-4511-b96f-85e7a291e318',
  elves: '11111111-1111-4111-8111-111111111111',
  ayula: '22222222-2222-4222-8222-222222222222',
  reanimate: '33333333-3333-4333-8333-333333333333',
};
export const CARDS = [
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
    id: ID.reanimate,
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
export const CSV =
  'Binder Name,Binder Type,Name,Quantity,Scryfall ID,Set code,Collector number,Foil,Purchase price\n' +
  `all cards,binder,Sol Ring,2,${ID.solRing},C21,263,normal,1.50\n` +
  `all cards,binder,Llanowar Elves,3,${ID.elves},M19,314,normal,0.25\n` +
  `all cards,binder,"Ayula, Queen Among Bears",1,${ID.ayula},MH1,155,foil,4.00\n`;
export const PRECON = '1 Reanimate\n1 Missing Card (zzz) 1\n';
export const DECK = `schema_version: 1
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

export const OWNER = 'daniel@example.com';
export const OTHER = 'second@example.com';

export const callTool = async (session, name, args = {}) => {
  const response = await mcp(session.tokens.access_token, 'tools/call', { name, arguments: args });
  const body = await response.json();
  if (body.error) return { error: body.error.message };
  return { text: body.result.content.map((part) => part.text).join('\n'), isError: Boolean(body.result.isError) };
};

// Loads the fixture cards; call it in beforeAll.
export async function loadFixtureCards() {
  await clearCardTables();
  await ingest(CARDS);
}

// Signs both people in and gives the owner their collections and deck; call it in beforeEach, since
// setup.mjs empties users before each test. Returns both sessions.
export async function seedPeople() {
  const owner = await signIn(OWNER);
  const other = await signIn(OTHER);
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
  return { owner, other };
}
