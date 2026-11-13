// build_deck, teardown_deck and swap_deck on the shared fixture (tool-fixtures.mjs): the bears deck
// takes Ayula, a Sol Ring and a Llanowar Elves from ManaBox_Collection, with untracked Forests.
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { entriesFor } from '../../src/storage/collection-writes.mjs';
import { listCollections } from '../../src/storage/collections.mjs';
import { loadDeckForUpdate } from '../../src/storage/decks.mjs';
import { OWNER, callTool, loadFixtureCards, seedPeople } from './tool-fixtures.mjs';

let owner;

beforeAll(loadFixtureCards);

beforeEach(async () => {
  ({ owner } = await seedPeople());
});

const userId = async () => (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(OWNER).first()).id;
async function rows(name) {
  const id = await userId();
  const collection = (await listCollections(env.DB, id)).find((candidate) => candidate.name === name);
  if (!collection) return undefined;
  return (await entriesFor(env.DB, id, collection.id)).map((entry) => [entry.name, entry.quantity, entry.set_code]);
}
const deck = async () => (await loadDeckForUpdate(env.DB, await userId(), 'bears')).deck;

const build = () => callTool(owner, 'build_deck', { slug: 'bears', apply: true });

describe('build_deck', () => {
  it('shows the plan, then moves the cards into the deck’s own list', async () => {
    const before = await rows('ManaBox_Collection');
    const plan = await callTool(owner, 'build_deck', { slug: 'bears' });
    expect(plan.text.split('\n')).toEqual([
      'Would take from ManaBox_Collection:',
      '  1 Ayula, Queen Among Bears (MH1) 155 *F*',
      '  1 Sol Ring (C21) 263',
      '  1 Llanowar Elves (M19) 314',
      'Would put into decks/bears (new):',
      '  1 Ayula, Queen Among Bears (MH1) 155 *F*',
      '  1 Sol Ring (C21) 263',
      '  1 Llanowar Elves (M19) 314',
      '  97 Forest',
      '(cards listed by name alone are untracked basics, from unlimited_basics)',
      'Would create decks/bears and mark bears built.',
      'Nothing changed; call again with apply: true once the person has sleeved the deck.',
    ]);
    expect(await rows('ManaBox_Collection')).toEqual(before);
    expect((await build()).text).toMatch(
      /^Took from ManaBox_Collection:[\s\S]*Built bears: its cards are now in decks\/bears\.$/,
    );
    expect(await rows('ManaBox_Collection')).toEqual([
      ['Sol Ring', 1, 'C21'],
      ['Llanowar Elves', 2, 'M19'],
    ]);
    expect(await rows('decks/bears')).toEqual([
      ['Ayula, Queen Among Bears', 1, 'mh1'],
      ['Sol Ring', 1, 'c21'],
      ['Llanowar Elves', 1, 'm19'],
      ['Forest', 97, null],
    ]);
    expect(await deck()).toMatchObject({ status: 'built', collection_destination: 'collections/decks/bears.txt' });
    expect((await callTool(owner, 'check_deck', { slug: 'bears' })).text).toMatch(/PASS/);
    expect((await callTool(owner, 'collection_changes', { since: '2026-01-01' })).text).toContain(
      'ManaBox_Collection: -1 Ayula, Queen Among Bears, -1 Llanowar Elves, -1 Sol Ring',
    );
  });

  it('refuses a built deck, a taken name, and a deck that fails its check', async () => {
    expect((await callTool(owner, 'build_deck', { slug: 'bears', to: 'ManaBox_Collection' })).text).toBe(
      'ManaBox_Collection already exists; choose another with to',
    );
    await build();
    expect((await callTool(owner, 'build_deck', { slug: 'bears' })).text).toBe(
      'bears is already built into collections/decks/bears.txt',
    );
    await callTool(owner, 'create_deck', { slug: 'short', commanders: ['Ayula, Queen Among Bears'] });
    expect((await callTool(owner, 'build_deck', { slug: 'short' })).text).toMatch(
      /Not built: short must pass check_deck first\.$/,
    );
  });

  it('applies nothing when the collection changed after it was read', async () => {
    // Removing the only Ayula leaves the build short, so it plans nothing at all.
    await callTool(owner, 'remove_cards', { collection: 'ManaBox_Collection', cards: '1 Ayula, Queen Among Bears' });
    expect((await build()).text).toMatch(/Not built/);
    expect(await rows('decks/bears')).toBeUndefined();
    expect((await deck()).status).toBe('draft');
  });
});

describe('teardown_deck', () => {
  it('returns the cards, lands apart, and deletes the deck’s own list', async () => {
    await build();
    const plan = await callTool(owner, 'teardown_deck', {
      slug: 'bears',
      to: 'ManaBox_Collection',
      lands_to: 'binders/Lands',
    });
    expect(plan.text).toMatch(/Would return into ManaBox_Collection:/);
    expect(await rows('decks/bears')).toHaveLength(4);
    const done = await callTool(owner, 'teardown_deck', { slug: 'bears', to: 'ManaBox_Collection', apply: true });
    expect(done.text.split('\n')).toEqual([
      'Returned into ManaBox_Collection:',
      '  1 Ayula, Queen Among Bears (MH1) 155 *F*',
      '  1 Sol Ring (C21) 263',
      '  1 Llanowar Elves (M19) 314',
      'Untracked basics (unlimited_basics), returned nowhere:',
      '  97 Forest',
      'Tore down bears: deleted decks/bears, and the deck is a draft again.',
    ]);
    expect(await rows('decks/bears')).toBeUndefined();
    expect(await rows('ManaBox_Collection')).toEqual([
      ['Sol Ring', 2, 'C21'],
      ['Llanowar Elves', 3, 'M19'],
      ['Ayula, Queen Among Bears', 1, 'mh1'],
    ]);
    const torn = await deck();
    expect(torn.status).toBe('draft');
    expect(torn.collection_destination).toBeUndefined();
  });

  it('refuses a draft and the deck’s own list, and warns about protected destinations', async () => {
    expect((await callTool(owner, 'teardown_deck', { slug: 'bears', to: 'binder' })).text).toBe(
      'bears isn’t built'.replace('’', "'"),
    );
    await build();
    expect((await callTool(owner, 'teardown_deck', { slug: 'bears', to: 'decks/bears' })).text).toBe(
      "decks/bears is this deck's own list",
    );
    const done = await callTool(owner, 'teardown_deck', { slug: 'bears', to: 'precons/Box', apply: true });
    expect(done.text).toMatch(/WARNING: precons\/Box is protected, so no deck will count the returned cards$/);
  });
});

describe('swap_deck', () => {
  beforeEach(async () => {
    await callTool(owner, 'add_cards', { collection: 'ManaBox_Collection', cards: '1 Bearded Bear' });
  });

  it('moves the in card into the deck’s own list and the out card back', async () => {
    await build();
    const args = {
      slug: 'bears',
      out: ['Sol Ring'],
      in: ['Bearded Bear'],
      reasons: ['Too strong'],
      to: 'binders/Returned',
    };
    const plan = await callTool(owner, 'swap_deck', args);
    expect(plan.text).toMatch(/^Would swap in the deck: -1 Sol Ring, \+1 Bearded Bear\n/);
    const done = await callTool(owner, 'swap_deck', { ...args, apply: true });
    expect(done.text).toContain('WARNING: the upgrade adding Bearded Bear is done by the swap; remove it');
    expect(await rows('decks/bears')).toEqual([
      ['Ayula, Queen Among Bears', 1, 'mh1'],
      ['Llanowar Elves', 1, 'm19'],
      ['Forest', 97, null],
      ['Bearded Bear', 1, expect.any(String)],
    ]);
    expect(await rows('binders/Returned')).toEqual([['Sol Ring', 1, 'c21']]);
    expect((await rows('ManaBox_Collection')).map(([name]) => name)).not.toContain('Bearded Bear');
    const swapped = await deck();
    expect(swapped.mainboard.map((entry) => entry.name)).toEqual(['Bearded Bear', 'Llanowar Elves', 'Forest']);
    expect(swapped.history.at(-1)).toMatchObject({ changes: '-Sol Ring, +Bearded Bear', notes: 'Too strong' });
    await callTool(owner, 'update_deck', { slug: 'bears', ops: [{ op: 'remove_upgrade', add: 'Bearded Bear' }] });
    expect((await callTool(owner, 'check_deck', { slug: 'bears' })).text).toMatch(/PASS/);
  });

  it('sends a draft to update_deck and refuses cards it can’t swap', async () => {
    const args = { slug: 'bears', out: ['Llanowar Elves'], in: ['Bearded Bear'], to: 'binders/Returned' };
    expect((await callTool(owner, 'swap_deck', args)).text).toMatch(
      /isn't built, so no physical cards move; use update_deck/,
    );
    await build();
    expect((await callTool(owner, 'swap_deck', { ...args, out: ['Reanimate'] })).text).toBe(
      'Reanimate: the mainboard has 0, fewer than the 1 to swap out',
    );
    expect((await callTool(owner, 'swap_deck', { ...args, in: ['Bearded Bear', 'Sol Ring'] })).text).toBe(
      'Give one in card for each out card',
    );
    expect((await callTool(owner, 'swap_deck', args)).text).toMatch(
      /Upgrade cuts 1 Llanowar Elves, but the mainboard has 0\n[\s\S]*Not swapped: bears is built, so the swapped deck must pass check_deck\.$/,
    );
    expect((await callTool(owner, 'swap_deck', { ...args, out: ['Sol Ring'], to: undefined })).text).toBe(
      'Name the collection the swapped-out cards go back to with to',
    );
  });
});
