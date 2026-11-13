// draft_deck and update_deck, and the review tools that read what they save (verify_deck,
// deck_candidates, deck_upgrades), on the shared fixture (tool-fixtures.mjs).
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadDeckForUpdate, saveDeck } from '../../src/storage/decks.mjs';
import { OTHER, OWNER, callTool, loadFixtureCards, seedPeople } from './tool-fixtures.mjs';

let owner;
let other;

beforeAll(loadFixtureCards);

beforeEach(async () => {
  ({ owner, other } = await seedPeople());
});

const userId = async (email) => (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()).id;
const stored = async (slug, email = OWNER) => (await loadDeckForUpdate(env.DB, await userId(email), slug))?.deck;
const today = () => new Date().toISOString().slice(0, 10);

describe('draft_deck', () => {
  it('creates a draft with the card data’s spelling and records its bracket', async () => {
    const result = await callTool(owner, 'draft_deck', {
      slug: 'elf-ball',
      commanders: ['ayula, queen among bears'],
      target_bracket: 2,
      unlimited_basics: true,
      primer: 'Elves into bears.',
      mainboard: [
        { name: 'llanowar elves', role: 'ramp' },
        { name: 'Forest', quantity: 98, role: 'land' },
      ],
    });
    expect(result).toEqual({
      isError: false,
      text: 'Created elf-ball (commander, draft). 100 cards: 1 commanders, 99 mainboard.\nlowest_legal_bracket is now 1',
    });
    const deck = await stored('elf-ball');
    expect(deck).toMatchObject({
      name: 'Elf Ball',
      status: 'draft',
      target_bracket: 2,
      lowest_legal_bracket: 1,
      allow_proxies: false,
      unlimited_basics: true,
      commanders: [{ name: 'Ayula, Queen Among Bears', quantity: 1 }],
      mainboard: [
        { name: 'Llanowar Elves', quantity: 1, role: 'ramp' },
        { name: 'Forest', quantity: 98, role: 'land' },
      ],
    });
    expect((await callTool(owner, 'list_decks')).text).toContain('elf-ball: Elf Ball (commander, draft)');
    expect((await callTool(owner, 'check_deck', { slug: 'elf-ball' })).text).toMatch(/^PASS: elf-ball \(100 cards\)/);
  });

  it('refuses a taken slug, unknown cards and a commander deck without commanders', async () => {
    expect(await callTool(owner, 'draft_deck', { slug: 'bears', commanders: ['Ayula, Queen Among Bears'] })).toEqual({
      isError: true,
      text: 'A deck named bears already exists; update_deck changes it',
    });
    expect(
      (
        await callTool(owner, 'draft_deck', {
          slug: 'x',
          commanders: ['Ayula, Queen Among Bears'],
          mainboard: [{ name: 'Llanowar Elfs' }],
        })
      ).text,
    ).toBe('Llanowar Elfs: no card by that name; did you mean Llanowar Elves?');
    expect((await callTool(owner, 'draft_deck', { slug: 'x' })).text).toMatch(/Commander decks need commanders/);
    expect(await stored('x')).toBeUndefined();
  });

  it('creates casual decks without commanders or brackets', async () => {
    const result = await callTool(owner, 'draft_deck', {
      slug: 'bolts',
      format: 'casual-60',
      mainboard: [{ name: 'Lightning Bolt', quantity: 4 }],
    });
    expect(result.text).toBe('Created bolts (casual-60, draft). 4 cards: 0 commanders, 4 mainboard.');
    expect(await stored('bolts')).not.toHaveProperty('lowest_legal_bracket');
  });
});

describe('update_deck', () => {
  it('swaps as deck:swap does, recording the reason and history', async () => {
    const result = await callTool(owner, 'update_deck', {
      slug: 'bears',
      ops: [
        { op: 'remove_upgrade', add: 'Bearded Bear' },
        { op: 'swap', out: 'Llanowar Elves', in: 'bearded bear', reason: 'More bears.' },
      ],
    });
    expect(result.text).toBe(
      'Saved bears: 2 changes. 100 cards: 1 commanders, 99 mainboard.\nlowest_legal_bracket is now 3',
    );
    const deck = await stored('bears');
    expect(deck.mainboard).toContainEqual({ name: 'Bearded Bear', quantity: 1, role: 'ramp' });
    expect(deck.mainboard.find((entry) => entry.name === 'Llanowar Elves')).toBeUndefined();
    expect(deck.considered).toEqual([{ name: 'Llanowar Elves', reason: 'More bears.' }]);
    expect(deck.history).toEqual([{ date: today(), changes: '-Llanowar Elves, +Bearded Bear', notes: 'More bears.' }]);
    expect(deck.upgrades).toEqual([]);
    // The left-out Elves now show with their reason.
    expect((await callTool(owner, 'deck_candidates', { slug: 'bears' })).text).toContain('    considered: More bears.');
  });

  it('saves all of the changes or none of them', async () => {
    const before = await stored('bears');
    const result = await callTool(owner, 'update_deck', {
      slug: 'bears',
      ops: [
        { op: 'add', name: 'Lightning Bolt' },
        { op: 'remove', name: 'Nope' },
      ],
    });
    expect(result).toEqual({ isError: true, text: 'remove: The mainboard has no Nope' });
    expect(await stored('bears')).toEqual(before);
  });

  it('refuses a list the deck’s upgrades no longer fit, or the schema refuses', async () => {
    expect(
      (await callTool(owner, 'update_deck', { slug: 'bears', ops: [{ op: 'remove', name: 'Llanowar Elves' }] })).text,
    ).toMatch(/Upgrade cuts 1 Llanowar Elves, but the mainboard has 0/);
    expect(
      (await callTool(owner, 'update_deck', { slug: 'bears', ops: [{ op: 'set', field: 'target_bracket', value: 9 }] }))
        .isError,
    ).toBe(true);
    expect(
      (await callTool(owner, 'update_deck', { slug: 'bears', ops: [{ op: 'set', field: 'status', value: 'built' }] }))
        .text,
    ).toMatch(/becomes built when build_deck moves its physical cards/);
    const unknownField = await callTool(owner, 'update_deck', {
      slug: 'bears',
      ops: [{ op: 'set', field: 'collection_destination', value: 'collections/x.txt' }],
    });
    expect(unknownField.isError || unknownField.error).toBeTruthy();
  });

  it('removes plays_like_bracket when the cards change, unless the same change judges it', async () => {
    await callTool(owner, 'update_deck', {
      slug: 'bears',
      ops: [{ op: 'set', field: 'plays_like_bracket', value: 3 }],
    });
    expect((await stored('bears')).plays_like_bracket).toBe(3);
    const judged = await callTool(owner, 'update_deck', {
      slug: 'bears',
      ops: [
        { op: 'remove', name: 'Forest', quantity: 1 },
        { op: 'add', name: 'Lightning Bolt', role: 'removal' },
        { op: 'set', field: 'plays_like_bracket', value: 3 },
      ],
    });
    expect(judged.text).not.toContain('removed plays_like_bracket');
    const changed = await callTool(owner, 'update_deck', {
      slug: 'bears',
      ops: [
        { op: 'set_role', name: 'Lightning Bolt', role: null },
        { op: 'remove', name: 'Lightning Bolt' },
        { op: 'add', name: 'Forest' },
      ],
    });
    expect(changed.text).toContain('removed plays_like_bracket because the card list changed; judge it again');
    expect(await stored('bears')).not.toHaveProperty('plays_like_bracket');
    // Notes and roles alone leave the judgment in place.
    await callTool(owner, 'update_deck', {
      slug: 'bears',
      ops: [{ op: 'set', field: 'plays_like_bracket', value: 3 }],
    });
    await callTool(owner, 'update_deck', {
      slug: 'bears',
      ops: [
        { op: 'set', field: 'power_notes', value: 'Sol Ring is the only Game Changer.' },
        { op: 'set_role', name: 'Sol Ring', role: 'ramp,draw' },
      ],
    });
    expect((await stored('bears')).plays_like_bracket).toBe(3);
  });

  it('records considered reasons, upgrades, history and playtests', async () => {
    await callTool(owner, 'update_deck', {
      slug: 'bears',
      ops: [
        { op: 'consider', name: 'reanimate', reason: 'Off color.' },
        { op: 'add_upgrade', add: 'Lightning Bolt', cut: 'Sol Ring', reason: 'Cheaper.' },
        { op: 'add_history', changes: 'Reviewed.', date: '2026-11-01' },
        { op: 'add_playtest', notes: 'Won on turn 9.' },
        { op: 'set', field: 'budget', value: { amount: 20, currency: 'USD' } },
      ],
    });
    const deck = await stored('bears');
    expect(deck.considered).toEqual([{ name: 'Reanimate', reason: 'Off color.' }]);
    expect(deck.upgrades.at(-1)).toEqual({
      add: { name: 'Lightning Bolt', quantity: 1 },
      cut: { name: 'Sol Ring', quantity: 1 },
      reason: 'Cheaper.',
    });
    expect(deck.history).toEqual([{ date: '2026-11-01', changes: 'Reviewed.' }]);
    expect(deck.playtests).toEqual([{ date: today(), notes: 'Won on turn 9.' }]);
    expect(deck.budget).toEqual({ amount: 20, currency: 'USD' });
    expect((await callTool(owner, 'deck_upgrades', { slug: 'bears' })).text).toMatch(
      /Lightning Bolt[\s\S]*of 20\.00 USD budget/,
    );
    await callTool(owner, 'update_deck', {
      slug: 'bears',
      ops: [
        { op: 'unconsider', name: 'Reanimate' },
        { op: 'set', field: 'budget', value: null },
      ],
    });
    const after = await stored('bears');
    expect(after.considered).toEqual([]);
    expect(after).not.toHaveProperty('budget');
  });

  it('refuses collection patterns that could run too long or don’t compile', async () => {
    const set = (value) =>
      callTool(owner, 'update_deck', { slug: 'bears', ops: [{ op: 'set', field: 'collection_source', value }] });
    expect((await set(['collections/**/**/**/x*'])).text).toBe(
      'set: collection_source: collections/**/**/**/x* has more than 4 * wildcards',
    );
    expect((await set(['collections/[z-a]'])).text).toBe(
      'set: collection_source: collections/[z-a] is not a valid path pattern',
    );
    expect((await set(['collections/binders*'])).isError).toBe(false);
    expect((await stored('bears')).collection_source).toEqual(['collections/binders*']);
  });

  it('keeps a built deck’s card list', async () => {
    const id = await userId(OWNER);
    const { deck, updatedAt } = await loadDeckForUpdate(env.DB, id, 'bears');
    const built = { ...deck, status: 'built', collection_destination: 'collections/decks/bears.txt' };
    expect(await saveDeck(env.DB, id, 'bears', built, { updatedAt, now: Date.now() })).toBe(true);
    expect(
      (await callTool(owner, 'update_deck', { slug: 'bears', ops: [{ op: 'add', name: 'Forest' }] })).text,
    ).toMatch(/bears is built: its cards are in collections\/decks\/bears\.txt/);
    expect(
      (await callTool(owner, 'update_deck', { slug: 'bears', ops: [{ op: 'set', field: 'notes', value: 'Sleeved.' }] }))
        .isError,
    ).toBe(false);
  });

  it('refuses a save over a newer one', async () => {
    const id = await userId(OWNER);
    const first = await loadDeckForUpdate(env.DB, id, 'bears');
    const now = Date.now();
    expect(
      await saveDeck(env.DB, id, 'bears', { ...first.deck, notes: 'one' }, { updatedAt: first.updatedAt, now }),
    ).toBe(true);
    expect(
      await saveDeck(env.DB, id, 'bears', { ...first.deck, notes: 'two' }, { updatedAt: first.updatedAt, now }),
    ).toBe(false);
    expect((await stored('bears')).notes).toBe('one');
  });

  it('changes only the caller’s own deck', async () => {
    expect(
      await callTool(other, 'draft_deck', { slug: 'bears', commanders: ['Ayula, Queen Among Bears'] }),
    ).toMatchObject({
      isError: false,
    });
    await callTool(other, 'update_deck', { slug: 'bears', ops: [{ op: 'add', name: 'Forest', quantity: 99 }] });
    expect((await stored('bears', OTHER)).mainboard).toEqual([{ name: 'Forest', quantity: 99 }]);
    expect((await stored('bears')).mainboard.map((entry) => entry.name)).toEqual([
      'Sol Ring',
      'Llanowar Elves',
      'Forest',
    ]);
  });
});

describe('verify_deck', () => {
  it('adds the hand-off checks to check_deck, with this server’s advice', async () => {
    const { text } = await callTool(owner, 'verify_deck', { slug: 'bears' });
    expect(text).toMatch(/^FAIL: bears/);
    expect(text).toContain("lowest_legal_bracket: isn't set, but the cards set 3; any update_deck call records it");
    expect(text).toContain('plays_like_bracket: not judged for this list');
    expect(text).not.toContain('decklist files');
  });
});
