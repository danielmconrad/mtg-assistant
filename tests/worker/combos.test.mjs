// find_combos on the shared fixture, with Commander Spellbook mocked: what it's sent, how its combos
// and near combos read, and how it refuses bad answers and bad requests.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CARDS, callTool, loadFixtureCards, seedPeople } from './tool-fixtures.mjs';

let owner;

beforeAll(loadFixtureCards);

beforeEach(async () => {
  ({ owner } = await seedPeople());
});

const oracleIdOf = (name) => CARDS.find((card) => card.name === name).oracle_id;
const use = (name, oracleId = oracleIdOf(name)) => ({ card: { name, oracleId }, quantity: 1 });

const variant = (id, names, fields = {}) => ({
  id,
  uses: names.map((name) => use(name)),
  requires: [],
  produces: [{ feature: { name: 'Infinite green mana' }, quantity: 1 }],
  identity: 'G',
  bracketTag: 'P',
  popularity: 100,
  description: 'Tap Llanowar Elves.\nUntap it.',
  manaNeeded: '{G}',
  easyPrerequisites: 'All permanents on the battlefield.',
  notablePrerequisites: '',
  ...fields,
});

const RESULTS = {
  identity: 'G',
  included: [variant('1-2', ['Sol Ring', 'Llanowar Elves'])],
  includedByChangingCommanders: [],
  almostIncluded: [
    variant('1-3', ['Sol Ring', 'Bearded Bear'], { popularity: 900 }),
    variant('1-4', ['Llanowar Elves', 'Reanimate'], {
      popularity: 5,
      identity: 'BG',
      bracketTag: 'R',
      requires: [{ template: { name: 'Sacrifice Outlet' }, quantity: 1 }],
    }),
    variant('1-5', ['Sol Ring', 'Lightning Bolt', 'Bearded Bear']),
  ],
  almostIncludedByAddingColors: [variant('9-9', ['Sol Ring', 'Lightning Bolt'])],
  almostIncludedByChangingCommanders: [],
  almostIncludedByAddingColorsAndChangingCommanders: [],
};

function mockSpellbook(answer = () => Response.json({ results: RESULTS })) {
  const requests = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== 'https://backend.commanderspellbook.com/find-my-combos') {
      throw new Error(`Unexpected outbound fetch in test: ${url}`);
    }
    requests.push({ method: init.method, body: JSON.parse(init.body) });
    return answer();
  });
  return requests;
}

describe('find_combos', () => {
  it('sends a deck’s card names, and lists its combos and near combos by what the person owns', async () => {
    const requests = mockSpellbook();
    const { text } = await callTool(owner, 'find_combos', { slug: 'bears' });
    expect(requests).toEqual([
      {
        method: 'POST',
        body: {
          commanders: [{ card: 'Ayula, Queen Among Bears', quantity: 1 }],
          main: ['Sol Ring', 'Llanowar Elves', 'Forest'].map((card) => ({ card, quantity: 1 })),
        },
      },
    ]);
    expect(text.split('\n').slice(0, 6)).toEqual([
      'Commander Spellbook: 1 combos in bears, 2 one card away within its colors, 1 more needing other colors.',
      'Combos:',
      '- Sol Ring + Llanowar Elves → Infinite green mana [G, Powerful] https://commanderspellbook.com/combo/1-2/',
      'One card away:',
      // Reanimate sits in a protected precon, so it comes before the unowned Bearded Bear despite popularity.
      '- Add Reanimate (1 in protected/precons/Spooky (protected)): Llanowar Elves + Reanimate + a Sacrifice Outlet → Infinite green mana [BG, Ruthless] https://commanderspellbook.com/combo/1-4/',
      '- Add Bearded Bear (not owned): Sol Ring + Bearded Bear → Infinite green mana [G, Powerful] https://commanderspellbook.com/combo/1-3/',
    ]);
    // A combo missing two cards isn't one card away.
    expect(text).not.toContain('1-5');
    expect(text).not.toContain('Untap it');
  });

  it('checks a list of cards, with steps, and canonical names', async () => {
    const requests = mockSpellbook();
    const { text } = await callTool(owner, 'find_combos', {
      cards: ['sol ring', 'Llanowar Elves'],
      commanders: ['Ayula, Queen Among Bears'],
      near: false,
      steps: true,
    });
    expect(requests[0].body.main.map((entry) => entry.card)).toEqual(['Sol Ring', 'Llanowar Elves']);
    expect(text).toContain('Commander Spellbook: 1 combos in those cards');
    expect(text).toContain(
      [
        '    Mana: {G}',
        '    Needs: All permanents on the battlefield.',
        '    Tap Llanowar Elves.',
        '    Untap it.',
      ].join('\n'),
    );
    expect(text).not.toContain('One card away');
  });

  it('counts copies the person has free for a near combo', async () => {
    mockSpellbook(() =>
      Response.json({ results: { ...RESULTS, almostIncluded: [variant('1-6', ['Lightning Bolt', 'Sol Ring'])] } }),
    );
    const { text } = await callTool(owner, 'find_combos', { cards: ['Lightning Bolt'] });
    expect(text).toContain('- Add Sol Ring (2 available): Lightning Bolt + Sol Ring');
  });

  it('adds named cards to a deck’s', async () => {
    const requests = mockSpellbook();
    const { text } = await callTool(owner, 'find_combos', { slug: 'bears', cards: ['Bearded Bear'] });
    expect(requests[0].body.main.map((entry) => entry.card)).toEqual([
      'Sol Ring',
      'Llanowar Elves',
      'Forest',
      'Bearded Bear',
    ]);
    // Bearded Bear is in the list now: its combo with Sol Ring isn't near, and the one with Lightning Bolt is.
    expect(text).toMatch(/^Commander Spellbook: 1 combos in bears with those cards, 2 one card away/);
    expect(text).not.toContain('Add Bearded Bear');
    expect(text).toContain('- Add Lightning Bolt (not owned): Sol Ring + Lightning Bolt + Bearded Bear');
  });

  it('refuses unknown names, a request with no cards, and other people’s decks', async () => {
    const requests = mockSpellbook();
    expect((await callTool(owner, 'find_combos', { cards: ['Sol Rign'] })).text).toBe(
      'No card named Sol Rign; did you mean Sol Ring?',
    );
    expect((await callTool(owner, 'find_combos', {})).text).toBe('Pass a deck’s slug, cards, or both');
    expect((await callTool(owner, 'find_combos', { slug: 'bears', commanders: ['Sol Ring'] })).text).toBe(
      'A deck has its own commanders; pass commanders only with cards',
    );
    expect((await callTool(owner, 'find_combos', { slug: 'nope' })).text).toBe(
      'No deck named nope; list_decks shows yours',
    );
    expect(requests).toEqual([]);
  });

  it('refuses an answer in an unexpected shape, and reports failures', async () => {
    mockSpellbook(() => Response.json({ results: { included: [{ id: 1 }], almostIncluded: [] } }));
    expect((await callTool(owner, 'find_combos', { slug: 'bears' })).text).toBe(
      'Commander Spellbook sent combos in a shape this server doesn’t recognize',
    );
    vi.restoreAllMocks();
    mockSpellbook(() => new Response('busy', { status: 503 }));
    expect((await callTool(owner, 'find_combos', { slug: 'bears' })).text).toBe(
      'Commander Spellbook answered 503; try again later',
    );
    vi.restoreAllMocks();
    mockSpellbook(() => {
      throw new TypeError('network down');
    });
    expect((await callTool(owner, 'find_combos', { slug: 'bears' })).text).toBe(
      'Commander Spellbook could not be reached; try again later',
    );
  });
});
