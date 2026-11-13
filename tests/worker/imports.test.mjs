// import_deck on the shared fixture, from pasted lists and from Archidekt (mocked).
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDeckForUpdate } from '../../src/storage/decks.mjs';
import { ID, OWNER, callTool, loadFixtureCards, seedPeople } from './tool-fixtures.mjs';

let owner;

beforeAll(loadFixtureCards);

beforeEach(async () => {
  ({ owner } = await seedPeople());
});

const stored = async (slug) => {
  const { id } = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(OWNER).first();
  return (await loadDeckForUpdate(env.DB, id, slug))?.deck;
};

const ARCHIDEKT = {
  name: 'Bear Force One',
  deckFormat: 3,
  categories: [
    { name: 'Commander', includedInDeck: true, isPremier: true },
    { name: 'Ramp', includedInDeck: true },
    { name: 'Land', includedInDeck: true },
    { name: 'Maybeboard', includedInDeck: false },
  ],
  cards: [
    {
      quantity: 1,
      categories: ['Commander'],
      card: { uid: ID.ayula, oracleCard: { name: 'Ayula, Queen Among Bears' } },
    },
    { quantity: 1, categories: ['Ramp'], card: { uid: ID.solRing, oracleCard: { name: 'Sol Ring' } } },
    { quantity: 1, categories: ['Ramp'], card: { uid: ID.elves, oracleCard: { name: 'Llanowar Elves' } } },
    { quantity: 30, categories: ['Land'], card: { oracleCard: { name: 'Forest' } } },
    { quantity: 1, categories: ['Maybeboard'], card: { oracleCard: { name: 'Lightning Bolt' } } },
  ],
};

function mockArchidekt(decks) {
  const urls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    const id = url.match(/^https:\/\/archidekt\.com\/api\/decks\/(\d+)\/$/)?.[1];
    if (id && decks[id]) return Response.json(decks[id]);
    if (id) return new Response('Not found', { status: 404 });
    throw new Error(`Unexpected outbound fetch in test: ${url}`);
  });
  return urls;
}

describe('import_deck from a list', () => {
  it('reads Arena and Moxfield sections, summing printings and leaving out the sideboard', async () => {
    const list = [
      'About',
      'Name Bears',
      '',
      'Commander',
      '1 Ayula, Queen Among Bears',
      '',
      'Deck',
      '1 Sol Ring (C21) 263',
      '1 sol ring',
      '2 Llanowar Elves *F*',
      '20 Forest',
      '',
      'Sideboard',
      '1 Lightning Bolt',
    ].join('\n');
    const { text, isError } = await callTool(owner, 'import_deck', { list, slug: 'pasted-bears' });
    expect(isError).toBe(false);
    expect(text.split('\n')).toEqual([
      'Created pasted-bears (commander, draft). 25 cards: 1 commanders, 24 mainboard.',
      'lowest_legal_bracket is now 3',
      'Left out 1 sideboard, maybeboard and companion cards.',
      'Its primer is a placeholder; check_deck shows what the deck still needs.',
    ]);
    expect(await stored('pasted-bears')).toMatchObject({
      name: 'Pasted Bears',
      status: 'draft',
      commanders: [{ name: 'Ayula, Queen Among Bears', quantity: 1 }],
      mainboard: [
        { name: 'Sol Ring', quantity: 2 },
        { name: 'Llanowar Elves', quantity: 2 },
        { name: 'Forest', quantity: 20 },
      ],
    });
  });

  it('reads Archidekt’s [Commander] marks, and takes named commanders out of a plain list', async () => {
    const marked =
      '1x Ayula, Queen Among Bears [Commander{top}]\n1x Sol Ring [Ramp]\n1x Lightning Bolt [Maybe{noDeck}]';
    expect((await callTool(owner, 'import_deck', { list: marked, slug: 'marked' })).text).toMatch(
      /^Created marked \(commander, draft\)\. 2 cards: 1 commanders, 1 mainboard\./,
    );
    const plain = '1 Sol Ring\n1 Ayula, Queen Among Bears\n10 Forest';
    const { text } = await callTool(owner, 'import_deck', {
      list: plain,
      slug: 'plain',
      commanders: ['Ayula, Queen Among Bears'],
    });
    expect(text).toMatch(/^Created plain \(commander, draft\)\. 12 cards: 1 commanders, 11 mainboard\./);
    expect((await stored('plain')).mainboard.map((entry) => entry.name)).toEqual(['Sol Ring', 'Forest']);
  });

  it('makes a list without commanders a casual deck', async () => {
    const { text } = await callTool(owner, 'import_deck', { list: '4 Lightning Bolt\n20 Forest', slug: 'burn' });
    expect(text).toMatch(/^Created burn \(casual-60, draft\)/);
  });

  it('refuses unknown cards, a missing slug, both sources, and an existing slug', async () => {
    expect((await callTool(owner, 'import_deck', { list: '1 Sol Rng', slug: 'x' })).text).toMatch(
      /^list: line 1: no card named Sol Rng; did you mean Sol Ring\?/,
    );
    expect((await callTool(owner, 'import_deck', { list: '1 Sol Ring' })).text).toMatch(/^Pass slug/);
    expect((await callTool(owner, 'import_deck', {})).text).toBe('Pass either url or list');
    expect(
      (await callTool(owner, 'import_deck', { list: '1 Sol Ring', url: 'https://archidekt.com/decks/1' })).text,
    ).toBe('Pass either url or list');
    expect((await callTool(owner, 'import_deck', { list: '1 Sol Ring', slug: 'bears' })).text).toMatch(
      /^A deck named bears already exists/,
    );
  });
});

describe('import_deck into an existing deck', () => {
  it('merges cards in, keeping the deck’s commanders', async () => {
    const { text } = await callTool(owner, 'import_deck', {
      list: 'Commander\n1 Bearded Bear\n\nDeck\n2 Lightning Bolt',
      mode: 'merge',
      slug: 'bears',
    });
    expect(text).toMatch(/^Saved bears: 1 change\. /);
    expect(text).toContain('Kept the deck’s commanders; replace takes the import’s.');
    const deck = await stored('bears');
    expect(deck.commanders.map((entry) => entry.name)).toEqual(['Ayula, Queen Among Bears']);
    expect(deck.mainboard.find((entry) => entry.name === 'Lightning Bolt')).toMatchObject({ quantity: 2 });
  });

  it('replaces its cards, commanders included', async () => {
    await callTool(owner, 'update_deck', { slug: 'bears', ops: [{ op: 'remove_upgrade', add: 'Bearded Bear' }] });
    const { text } = await callTool(owner, 'import_deck', {
      list: 'Commander\n1 Bearded Bear\n\nDeck\n1 Sol Ring\n30 Forest',
      mode: 'replace',
      slug: 'bears',
    });
    expect(text).toMatch(/^Saved bears: \d+ changes\. 32 cards: 1 commanders, 31 mainboard\./);
    const deck = await stored('bears');
    expect(deck.commanders.map((entry) => entry.name)).toEqual(['Bearded Bear']);
    expect(deck.mainboard.map((entry) => [entry.name, entry.quantity])).toEqual([
      ['Sol Ring', 1],
      ['Forest', 30],
    ]);
  });

  it('needs an existing deck, and leaves built decks’ cards alone', async () => {
    expect((await callTool(owner, 'import_deck', { list: '1 Sol Ring', mode: 'merge' })).text).toBe(
      'Pass slug: the deck to merge',
    );
    expect((await callTool(owner, 'import_deck', { list: '1 Sol Ring', mode: 'replace', slug: 'nope' })).text).toBe(
      'No deck named nope; list_decks shows yours',
    );
    await callTool(owner, 'build_deck', { slug: 'bears', apply: true });
    expect((await callTool(owner, 'import_deck', { list: '1 Sol Ring', mode: 'merge', slug: 'bears' })).text).toMatch(
      /^bears is built: its cards are in collections\/Bears\.txt/,
    );
  });
});

describe('import_deck from Archidekt', () => {
  it('fetches the deck through its API, with categories as sections and roles', async () => {
    const urls = mockArchidekt({ 123456: ARCHIDEKT });
    const { text, isError } = await callTool(owner, 'import_deck', {
      url: 'https://www.archidekt.com/decks/123456/bear_force_one',
    });
    expect(isError).toBe(false);
    expect(text.split('\n')[0]).toBe(
      'Created bear-force-one (commander, draft). 33 cards: 1 commanders, 32 mainboard.',
    );
    expect(text).toContain('Left out 1 sideboard, maybeboard and companion cards.');
    expect(urls).toEqual(['https://archidekt.com/api/decks/123456/']);
    expect(await stored('bear-force-one')).toMatchObject({
      name: 'Bear Force One',
      commanders: [{ name: 'Ayula, Queen Among Bears', quantity: 1 }],
      mainboard: [
        { name: 'Sol Ring', quantity: 1, role: 'ramp' },
        { name: 'Llanowar Elves', quantity: 1, role: 'ramp' },
        { name: 'Forest', quantity: 30, role: 'land' },
      ],
    });
  });

  it('refuses other sites, private decks and unexpected shapes without fetching anything else', async () => {
    const urls = mockArchidekt({ 2: { cards: 'nope' } });
    expect((await callTool(owner, 'import_deck', { url: 'https://www.moxfield.com/decks/abc' })).text).toMatch(
      /^Only Archidekt deck links/,
    );
    expect((await callTool(owner, 'import_deck', { url: 'https://archidekt.com.evil.example/decks/1' })).text).toMatch(
      /^Only Archidekt deck links/,
    );
    expect((await callTool(owner, 'import_deck', { url: 'https://archidekt.com/decks/1/x' })).text).toMatch(
      /^Archidekt deck 1 is private or doesn’t exist/,
    );
    expect((await callTool(owner, 'import_deck', { url: 'https://archidekt.com/decks/2' })).text).toBe(
      'Archidekt sent a deck in a shape this server doesn’t recognize',
    );
    expect(urls).toEqual(['https://archidekt.com/api/decks/1/', 'https://archidekt.com/api/decks/2/']);
  });
});
