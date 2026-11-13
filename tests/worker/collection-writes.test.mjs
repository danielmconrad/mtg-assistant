// add_cards, remove_cards and collection_changes on the shared fixture (tool-fixtures.mjs), and the
// revision guard that keeps two changes from applying to the same starting point.
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyCollectionChanges, entriesFor, planAdd } from '../../src/storage/collection-writes.mjs';
import { listCollections } from '../../src/storage/collections.mjs';
import { loadDeckForUpdate, saveDeck } from '../../src/storage/decks.mjs';
import { ID, OTHER, OWNER, callTool, loadFixtureCards, seedPeople } from './tool-fixtures.mjs';

let owner;
let other;

beforeAll(loadFixtureCards);

beforeEach(async () => {
  ({ owner, other } = await seedPeople());
});

const userId = async (email) => (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()).id;
async function rows(name, email = OWNER) {
  const id = await userId(email);
  const collection = (await listCollections(env.DB, id)).find((candidate) => candidate.name === name);
  if (!collection) return undefined;
  return (await entriesFor(env.DB, id, collection.id)).map((entry) => [
    entry.name,
    entry.quantity,
    entry.finish,
    entry.set_code,
  ]);
}

describe('add_cards', () => {
  it('adds to matching rows, or new rows, and names the decks that play them', async () => {
    const result = await callTool(owner, 'add_cards', {
      collection: 'ManaBox_Collection',
      cards: '2 Llanowar Elves (M19) 314\n1 lightning bolt\n1 Sol Ring (C21) 263 *F*',
      note: 'Bought at the LGS',
    });
    expect(result).toEqual({
      isError: false,
      text: 'Added 4 copies to ManaBox_Collection: +2 Llanowar Elves, +1 Lightning Bolt, +1 Sol Ring (foil).\nbears names Sol Ring, Llanowar Elves',
    });
    expect(await rows('ManaBox_Collection')).toEqual([
      ['Sol Ring', 2, 'normal', 'C21'],
      ['Llanowar Elves', 5, 'normal', 'M19'],
      ['Ayula, Queen Among Bears', 1, 'foil', 'MH1'],
      ['Lightning Bolt', 1, 'normal', null],
      ['Sol Ring', 1, 'foil', 'c21'],
    ]);
    expect((await callTool(owner, 'search_cards', { name: 'Elves' })).text).toContain('5x Llanowar Elves');
  });

  it('starts a new text list only when asked, protecting precons', async () => {
    expect((await callTool(owner, 'add_cards', { collection: 'binders/New', cards: '1 Forest' })).text).toMatch(
      /^No collection named binders\/New \(yours: ManaBox_Collection, protected\/precons\/Spooky\); pass create: true/,
    );
    expect(
      (await callTool(owner, 'add_cards', { collection: 'binders/New', cards: '3 Forest', create: true })).text,
    ).toBe('Added 3 copies to binders/New (new): +3 Forest.\nbears names Forest');
    expect(
      (await callTool(owner, 'add_cards', { collection: 'precons/Bears', cards: '1 Reanimate', create: true })).text,
    ).toBe('Added 1 copy to precons/Bears (new, protected): +1 Reanimate.');
    const summary = (await callTool(owner, 'collection_summary')).text;
    expect(summary).toContain('binders/New: 1 rows, 3 copies');
    expect(summary).toContain('precons/Bears (protected): 1 rows');
    for (const name of ['../escape', 'a//b', 'bad*name', '.hidden']) {
      expect(
        (await callTool(owner, 'add_cards', { collection: name, cards: '1 Forest', create: true })).text,
        name,
      ).toMatch(/can't be a collection name/);
    }
  });

  it('refuses lines that match no card, changing nothing', async () => {
    const before = await rows('ManaBox_Collection');
    const result = await callTool(owner, 'add_cards', {
      collection: 'ManaBox_Collection',
      cards: '1 Sol Ring\n1 Llanowar Elfs\n1 Lightning Bolt (ZZZ) 1\nnot a line',
    });
    expect(result).toEqual({
      isError: true,
      text: 'cards: line 4: expected "QUANTITY NAME (SET) NUMBER", got "not a line"',
    });
    const unmatched = await callTool(owner, 'add_cards', {
      collection: 'ManaBox_Collection',
      cards: '1 Sol Ring\n1 Llanowar Elfs\n1 Lightning Bolt (ZZZ) 1',
    });
    expect(unmatched.text).toBe(
      'cards: line 2: no card named Llanowar Elfs; did you mean Llanowar Elves?\ncards: line 3: no ZZZ 1 printing of Lightning Bolt',
    );
    expect(await rows('ManaBox_Collection')).toEqual(before);
  });

  it('leaves a built deck’s own list to its deck', async () => {
    const id = await userId(OWNER);
    const { deck, updatedAt } = await loadDeckForUpdate(env.DB, id, 'bears');
    const built = { ...deck, status: 'built', collection_destination: 'collections/protected/precons/Spooky.txt' };
    await saveDeck(env.DB, id, 'bears', built, { updatedAt, now: Date.now() });
    expect(
      (await callTool(owner, 'add_cards', { collection: 'protected/precons/Spooky', cards: '1 Forest' })).text,
    ).toBe('protected/precons/Spooky holds the built deck bears; its cards change only with that deck');
  });
});

describe('remove_cards', () => {
  it('takes copies out, deleting rows left empty', async () => {
    expect(
      (await callTool(owner, 'remove_cards', { collection: 'ManaBox_Collection', cards: '1 Sol Ring' })).text,
    ).toBe('Removed 1 copy from ManaBox_Collection: -1 Sol Ring.\nbears names Sol Ring');
    await callTool(owner, 'remove_cards', {
      collection: 'ManaBox_Collection',
      cards: '1 Sol Ring\n1 Ayula, Queen Among Bears',
    });
    expect(await rows('ManaBox_Collection')).toEqual([['Llanowar Elves', 3, 'normal', 'M19']]);
  });

  it('removes nothing unless every line can be removed', async () => {
    const result = await callTool(owner, 'remove_cards', {
      collection: 'ManaBox_Collection',
      cards: '1 Sol Ring\n4 Llanowar Elves\n1 Lightning Bolt',
    });
    expect(result.text).toBe(
      'cards: line 2: ManaBox_Collection has 3 of the 4 Llanowar Elves to remove\ncards: line 3: ManaBox_Collection has 0 of the 1 Lightning Bolt to remove',
    );
    expect((await rows('ManaBox_Collection'))[0]).toEqual(['Sol Ring', 2, 'normal', 'C21']);
  });

  it('asks for the printing when a name alone is ambiguous', async () => {
    await callTool(owner, 'add_cards', { collection: 'ManaBox_Collection', cards: '1 Sol Ring (C21) 263 *F*' });
    expect(
      (await callTool(owner, 'remove_cards', { collection: 'ManaBox_Collection', cards: '1 Sol Ring' })).text,
    ).toBe(
      'cards: line 1: Sol Ring is held in several printings (C21 263; C21 263 foil); name one as (SET) NUMBER, with *F* for foil',
    );
    await callTool(owner, 'remove_cards', { collection: 'ManaBox_Collection', cards: '1 Sol Ring (C21) 263 *F*' });
    expect((await rows('ManaBox_Collection')).filter(([name]) => name === 'Sol Ring')).toEqual([
      ['Sol Ring', 2, 'normal', 'C21'],
    ]);
  });
});

describe('collection_changes', () => {
  it('nets the changes since a date and lists each one', async () => {
    expect((await callTool(owner, 'collection_changes')).text).toMatch(
      /^No collection changes since \d{4}-\d{2}-\d{2}\./,
    );
    await callTool(owner, 'add_cards', { collection: 'ManaBox_Collection', cards: '2 Lightning Bolt', note: 'Trade' });
    await callTool(owner, 'remove_cards', { collection: 'ManaBox_Collection', cards: '1 Lightning Bolt\n1 Sol Ring' });
    await callTool(owner, 'add_cards', { collection: 'binders/New', cards: '1 Forest', create: true });
    const { text } = await callTool(owner, 'collection_changes', { since: '2026-01-01' });
    const lines = text.split('\n');
    expect(lines.slice(0, 6)).toEqual([
      'Collection changes since 2026-01-01:',
      '  binders/New: +1 Forest',
      '  ManaBox_Collection: +1 Lightning Bolt, -1 Sol Ring',
      'Decks naming changed cards:',
      '  bears: Sol Ring, Forest',
      'Changes made through MTG Assistant (UTC), newest first:',
    ]);
    expect(lines[6]).toMatch(/^ {2}\d{4}-\d\d-\d\d \d\d:\d\d add_cards, binders\/New: \+1$/);
    expect(lines[7]).toMatch(/ remove_cards, ManaBox_Collection: -2$/);
    expect(lines[8]).toMatch(/ add_cards, ManaBox_Collection: \+2 — Trade$/);
    expect(
      (await callTool(owner, 'collection_changes', { since: '2026-01-01', collection: 'binders/New' })).text,
    ).toMatch(/^Collection changes since 2026-01-01:\n {2}binders\/New: \+1 Forest\n/);
  });
});

describe('the revision guard', () => {
  it('writes nothing when the collection changed since it was read', async () => {
    const id = await userId(OWNER);
    const collection = (await listCollections(env.DB, id)).find((candidate) => candidate.name === 'ManaBox_Collection');
    const entries = await entriesFor(env.DB, id, collection.id);
    const change = (quantity) => ({
      collection,
      plan: planAdd(entries, [
        { name: 'Sol Ring', scryfallId: ID.solRing, set: 'c21', collectorNumber: '263', finish: 'etched', quantity },
      ]),
      events: [{ name: 'Sol Ring', scryfallId: ID.solRing, finish: 'etched', change: quantity }],
    });
    const context = { source: 'test', now: Date.now() };
    expect(await applyCollectionChanges(env.DB, id, [change(1)], context)).toBe(true);
    expect(await applyCollectionChanges(env.DB, id, [change(5)], context)).toBe(false);
    expect((await rows('ManaBox_Collection')).at(-1)).toEqual(['Sol Ring', 1, 'etched', 'c21']);
    const { n } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM collection_events WHERE user_id = ? AND source = 'test'",
    )
      .bind(id)
      .first();
    expect(n).toBe(1);
  });
});

describe('another person', () => {
  it('changes only their own collections', async () => {
    await callTool(other, 'add_cards', { collection: 'ManaBox_Collection', cards: '1 Forest', create: true });
    expect(await rows('ManaBox_Collection', OTHER)).toEqual([['Forest', 1, 'normal', null]]);
    expect(await rows('ManaBox_Collection')).toHaveLength(3);
    expect((await callTool(other, 'collection_changes', { since: '2026-01-01' })).text).not.toMatch(/Sol Ring|Elves/);
  });
});
