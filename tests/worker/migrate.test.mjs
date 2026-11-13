// A full migration round trip in D1: mtg-manager's files, parsed with the ported parsers, written by
// the migration's SQL and read back through the server's loaders, exactly.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrationStatements, sourceRecords, verify } from '../../scripts/migrate/plan.mjs';
import { parseCollection, parseTextCollection, resolveTextRows } from '../../src/core/collection.mjs';
import { parseDeck } from '../../src/core/deck.mjs';
import { cardIndexFor, loadCardRows } from '../../src/storage/cards.mjs';
import { listCollections, loadCollections } from '../../src/storage/collections.mjs';
import { listDecks, loadDeck } from '../../src/storage/decks.mjs';
import { scryfallCard } from '../fixtures/scryfall.mjs';
import { clearCardTables, ingest } from './ingest-helper.mjs';

const solRing = scryfallCard('Sol Ring', {
  id: '25ef2d44-c261-4511-b96f-85e7a291e318',
  set: 'c21',
  collector_number: '263',
});
const signet = scryfallCard('Arcane Signet', {
  id: 'a6813cd2-7151-459a-a2f1-52808584de53',
  set: 'ltc',
  collector_number: '273',
});
const elf = scryfallCard('Arbor Elf', { set: 'ltc', collector_number: '232' });

const CSV =
  'Binder Name,Binder Type,Name,Quantity,Scryfall ID,Set code,Collector number,Foil,Purchase price\n' +
  'all cards,binder,Sol Ring,2,25ef2d44-c261-4511-b96f-85e7a291e318,C21,263,normal,1.50\n' +
  'Goblins,deck,Arcane Signet,1,a6813cd2-7151-459a-a2f1-52808584de53,LTC,273,foil,0.80\n';
const BINDER = '1 Arbor Elf (LTC) 232\n2 Sol Ring\n1 Unknown Card (zzz) 9\n';
const PRECON = '1 Arcane Signet (LTC) 273 *F*\n';
const DECK = `schema_version: 1
name: Elves
format: commander
status: draft
allow_proxies: false
primer: Elves.
collection_source:
  - 'collections/**/*'
collection_destination: 'collections/protected/precons/Elves.txt'
commanders:
  - name: Arbor Elf
    quantity: 1
mainboard:
  - name: Sol Ring
    quantity: 1
    role: ramp
`;

async function person({ folder, email, userId, existing = false }) {
  const { index } = await cardIndexFor(
    env.DB,
    await loadCardRows(env.DB, { names: ['Arbor Elf', 'Sol Ring', 'Arcane Signet', 'Unknown Card'] }),
  );
  const resolve = (rows) => resolveTextRows(rows, index);
  return {
    folder,
    email,
    userId,
    existing,
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
        name: 'binders/Alphabetized',
        path: 'collections/binders/Alphabetized.txt',
        format: 'text',
        isProtected: false,
        rows: resolve(parseTextCollection(BINDER, 'binders/Alphabetized')),
        records: [],
      },
      {
        name: 'protected/precons/Elves',
        path: 'collections/protected/precons/Elves.txt',
        format: 'text',
        isProtected: true,
        rows: resolve(parseTextCollection(PRECON, 'protected/precons/Elves')),
        records: [],
      },
    ],
    decks: [{ slug: 'elves', deck: parseDeck(DECK) }],
  };
}

async function migrate(people) {
  for (const statement of migrationStatements(people, '2026-11-13T00:00:00.000Z')) {
    await env.DB.prepare(statement).run();
  }
}

beforeEach(async () => {
  await clearCardTables();
  await env.DB.batch(
    ['collection_entries', 'collections', 'decks'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
  await ingest([solRing, signet, elf]);
});

describe('migration round trip', () => {
  it('reads back exactly what it wrote', async () => {
    const people = [await person({ folder: 'conrad', email: 'daniel@example.com', userId: 'user-daniel' })];
    await migrate(people);
    expect(await verify(env.DB, people)).toEqual([]);
  });

  it('reserves an account for a person who has not signed in', async () => {
    await migrate([await person({ folder: 'brad', email: 'second@example.com', userId: 'user-brad' })]);
    const user = await env.DB.prepare('SELECT id, google_sub, pending FROM users WHERE email = ?')
      .bind('second@example.com')
      .first();
    expect(user).toEqual({ id: 'user-brad', google_sub: 'pending:user-brad', pending: 1 });
  });

  it("keeps an existing account's ID and adds no user", async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, email, google_sub, created_at, last_login_at) VALUES ('user-daniel', 'daniel@example.com', 'g1', 'x', 'x')",
    ).run();
    await migrate([
      await person({ folder: 'conrad', email: 'daniel@example.com', userId: 'user-daniel', existing: true }),
    ]);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()).n).toBe(1);
    expect(await listDecks(env.DB, 'user-daniel')).toMatchObject([{ slug: 'elves', name: 'Elves', status: 'draft' }]);
  });

  it('replaces the previous migration rather than adding to it', async () => {
    const people = [await person({ folder: 'conrad', email: 'daniel@example.com', userId: 'user-daniel' })];
    await migrate(people);
    await migrate([{ ...people[0], existing: true }]);
    expect(await listCollections(env.DB, 'user-daniel')).toHaveLength(3);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM collection_entries').first()).n).toBe(6);
  });
});

describe('the loaded collections', () => {
  beforeEach(async () => {
    await migrate([await person({ folder: 'conrad', email: 'daniel@example.com', userId: 'user-daniel' })]);
  });

  it("hold back protected collections and deck binders, as mtg-manager's workspace did", async () => {
    const collections = await loadCollections(env.DB, 'user-daniel');
    expect(collections.availableNames).toEqual(['ManaBox_Collection', 'binders/Alphabetized']);
    expect(collections.available.map((row) => `${row.collection}:${row.name}`)).toEqual([
      'ManaBox_Collection:Sol Ring',
      'binders/Alphabetized:Arbor Elf',
      'binders/Alphabetized:Sol Ring',
      'binders/Alphabetized:Unknown Card',
    ]);
    expect(collections.protected.map((row) => `${row.collection}:${row.name}`)).toEqual([
      'ManaBox_Collection decks:Arcane Signet',
      'protected/precons/Elves:Arcane Signet',
    ]);
  });

  it('match text rows to printings, keeping unmatched ones unresolved', async () => {
    const [, binder] = (await loadCollections(env.DB, 'user-daniel')).sources;
    expect(binder.rows.map((row) => [row.name, row.scryfallId ?? null, row.location])).toEqual([
      ['Arbor Elf', 'arbor-elf-print', 'binders/Alphabetized: line 1'],
      ['Sol Ring', '25ef2d44-c261-4511-b96f-85e7a291e318', 'binders/Alphabetized: line 2'],
      ['Unknown Card', null, 'binders/Alphabetized: line 3'],
    ]);
    const summary = await listCollections(env.DB, 'user-daniel');
    expect(summary.find((collection) => collection.name === 'binders/Alphabetized')).toMatchObject({
      row_count: 3,
      copies: 4,
      unresolved_rows: 1,
    });
  });

  it("apply a deck's collection_source patterns", async () => {
    const binders = await loadCollections(env.DB, 'user-daniel', { only: ['collections/binders'] });
    expect(binders.sources.map((source) => source.name)).toEqual(['binders/Alphabetized']);
    const none = await loadCollections(env.DB, 'user-daniel', { only: ['collections/nothing/*'] });
    expect(none.unknownOnly).toEqual(['collections/nothing/*']);
  });

  it("keep ManaBox's other columns for exports", async () => {
    const row = await env.DB.prepare(
      "SELECT source_record FROM collection_entries WHERE name = 'Sol Ring' AND source_record IS NOT NULL",
    ).first();
    expect(JSON.parse(row.source_record)).toEqual({ 'Binder Name': 'all cards', 'Purchase price': '1.50' });
  });

  it('are private: another user sees none of them', async () => {
    expect(await listCollections(env.DB, 'someone-else')).toEqual([]);
    expect((await loadCollections(env.DB, 'someone-else')).sources).toEqual([]);
    expect(await listDecks(env.DB, 'someone-else')).toEqual([]);
    expect(await loadDeck(env.DB, 'someone-else', 'elves')).toBeNull();
    expect((await loadDeck(env.DB, 'user-daniel', 'elves')).name).toBe('Elves');
  });
});

describe("a built deck's own collection", () => {
  it('is read even when protected, and never protected from that deck', async () => {
    await migrate([await person({ folder: 'conrad', email: 'daniel@example.com', userId: 'user-daniel' })]);
    const deck = await loadDeck(env.DB, 'user-daniel', 'elves');
    const collections = await loadCollections(env.DB, 'user-daniel', {
      only: deck.collection_source,
      own: deck.collection_destination,
    });
    expect(collections.availableNames).toContain('protected/precons/Elves');
    expect(collections.available.some((row) => row.collection === 'protected/precons/Elves')).toBe(true);
    expect(collections.missingOwn).toBeUndefined();
  });
});
