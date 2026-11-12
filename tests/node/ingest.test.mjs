import { describe, expect, it } from 'vitest';
import { checkDeletes, textLines } from '../../scripts/ingest-scryfall.mjs';
import { buildRows, diffRows, identityMask } from '../../scripts/ingest/rows.mjs';
import {
  MAX_STATEMENT_BYTES,
  chunkStatements,
  deleteStatements,
  ingestStatements,
  literal,
  upsertStatements,
} from '../../scripts/ingest/sql.mjs';
import { toCard } from '../../src/core/scryfall.mjs';
import { scryfallCard, tokenCard } from '../fixtures/scryfall.mjs';

const BUILT = '2026-11-12T10:06:21.099Z';
const asDefault = (object) => toCard(object, BUILT, { defaultPrinting: true });
const asPrinting = (object) => toCard(object, BUILT);

const solRing = scryfallCard('Sol Ring', {
  type_line: 'Artifact',
  mana_cost: '{1}',
  cmc: 1,
  oracle_text: '{T}: Add {C}{C}.',
  produced_mana: ['C'],
  game_changer: true,
  edhrec_rank: 1,
});
const solRingPromo = {
  ...solRing,
  id: 'sol-ring-promo',
  set: 'prm',
  collector_number: '99',
  rarity: 'uncommon',
  prices: { usd: '12.00' },
};
const gruul = scryfallCard('Gruul Signet', {
  type_line: 'Artifact',
  color_identity: ['R', 'G'],
  legalities: { commander: 'banned', standard: 'not_legal' },
});

describe('identityMask', () => {
  it('sets one bit per color', () => {
    expect(identityMask([])).toBe(0);
    expect(identityMask(['W', 'U', 'B', 'R', 'G'])).toBe(31);
    expect(identityMask(['G', 'R'])).toBe(24);
  });
});

describe('buildRows', () => {
  it('makes one card per oracle ID, based on the default printing', async () => {
    const rows = await buildRows([asDefault(solRing), asPrinting(solRingPromo), asPrinting(solRing)]);
    expect(rows.cards).toHaveLength(1);
    expect(rows.printings.map((row) => row.id)).toEqual(['sol-ring-print', 'sol-ring-promo']);
    const [card] = rows.cards;
    expect(card).toMatchObject({
      oracle_id: 'sol-ring-oracle',
      name: 'Sol Ring',
      name_key: 'sol ring',
      mana_value: 1,
      color_identity: 0,
      legal_commander: 1,
      playable: 1,
      game_changer: 1,
      edhrec_rank: 1,
      legalities: '{"commander":"legal"}',
    });
    expect(rows.printings.find((row) => row.id === 'sol-ring-print').is_default).toBe(1);
    expect(rows.printings.find((row) => row.id === 'sol-ring-promo')).toMatchObject({
      is_default: 0,
      set_code: 'prm',
      overrides: null,
    });
  });

  it('records banned cards, tokens and per-printing differences', async () => {
    const reversible = { ...solRing, id: 'sol-ring-reversible', name: 'Sol Ring // Sol Ring' };
    const oldSchool = { ...solRing, id: 'sol-ring-lea', legalities: { ...solRing.legalities, oldschool: 'legal' } };
    const rows = await buildRows([
      asDefault(solRing),
      asPrinting(reversible),
      asPrinting(oldSchool),
      asDefault(gruul),
      asDefault(tokenCard('Goblin')),
    ]);
    const card = (name) => rows.cards.find((row) => row.name === name);
    expect(card('Gruul Signet')).toMatchObject({
      legal_commander: 0,
      playable: 0,
      color_identity: 24,
      legalities: '{"commander":"banned"}',
    });
    expect(card('Goblin')).toMatchObject({ playable: 0, legal_commander: 0, edhrec_rank: null });
    const printing = (id) => rows.printings.find((row) => row.id === id);
    expect(JSON.parse(printing('sol-ring-reversible').overrides)).toEqual({
      name: 'Sol Ring // Sol Ring',
      frontName: 'Sol Ring // Sol Ring',
    });
    expect(printing('sol-ring-lea').printing_legalities).toBe('{"oldschool":"legal"}');
    expect(card('Sol Ring').legalities).not.toContain('oldschool');
  });

  it('stores prices as numbers, with null for missing ones', async () => {
    const rows = await buildRows([asDefault(solRing), asPrinting(solRingPromo)]);
    expect(rows.prices.find((row) => row.printing_id === 'sol-ring-print')).toMatchObject({
      usd: 1,
      usd_foil: 3.5,
      usd_etched: null,
      eur: 0.9,
    });
    expect(rows.prices.find((row) => row.printing_id === 'sol-ring-promo')).toMatchObject({ usd: 12, usd_foil: null });
  });

  it('skips objects without an ID, oracle ID or name', async () => {
    const rows = await buildRows([asDefault({ ...solRing, oracle_id: undefined }), asDefault(gruul)]);
    expect(rows.cards.map((row) => row.name)).toEqual(['Gruul Signet']);
  });

  it('hashes stably, and a price change touches only the price row', async () => {
    const before = await buildRows([asDefault(solRing)]);
    const again = await buildRows([asDefault(solRing)]);
    const repriced = await buildRows([asDefault({ ...solRing, prices: { ...solRing.prices, usd: '1.25' } })]);
    expect(again).toEqual(before);
    expect(repriced.cards[0].hash).toBe(before.cards[0].hash);
    expect(repriced.printings[0].hash).toBe(before.printings[0].hash);
    expect(repriced.prices[0].hash).not.toBe(before.prices[0].hash);
  });
});

describe('diffRows', () => {
  it('writes new and changed rows, and deletes rows that are gone', () => {
    const rows = [
      { id: 'a', hash: '1' },
      { id: 'b', hash: '2' },
      { id: 'c', hash: '3' },
    ];
    const current = new Map([
      ['a', '1'],
      ['b', 'old'],
      ['z', '9'],
    ]);
    const { upserts, deletes } = diffRows(rows, 'id', current);
    expect(upserts.map((row) => row.id)).toEqual(['b', 'c']);
    expect(deletes).toEqual(['z']);
  });
});

describe('checkDeletes', () => {
  const current = { cards: new Map(Array.from({ length: 1000 }, (_, index) => [String(index), 'h'])) };
  it('allows a few deletes', () => {
    expect(() => checkDeletes({ cards: { deletes: Array(20) } }, current)).not.toThrow();
  });
  it('refuses a suspicious share unless told otherwise', () => {
    expect(() => checkDeletes({ cards: { deletes: Array(21) } }, current)).toThrow(
      /Refusing to delete 21 of 1000 cards/,
    );
    expect(() => checkDeletes({ cards: { deletes: Array(500) } }, current, true)).not.toThrow();
  });
  it('allows anything on an empty database', () => {
    expect(() => checkDeletes({ cards: { deletes: [] } }, { cards: new Map() })).not.toThrow();
  });
});

describe('literal', () => {
  it('quotes strings and doubles single quotes', () => {
    expect(literal("Urza's Saga")).toBe("'Urza''s Saga'");
    expect(literal("'); DROP TABLE cards; --")).toBe("'''); DROP TABLE cards; --'");
    expect(literal('Lim-Dûl the Necromancer')).toBe("'Lim-Dûl the Necromancer'");
    expect(literal('line one\nline two')).toBe("'line one\nline two'");
  });
  it('writes numbers, booleans and null', () => {
    expect(literal(1.5)).toBe('1.5');
    expect(literal(0)).toBe('0');
    expect(literal(true)).toBe('1');
    expect(literal(null)).toBe('NULL');
    expect(literal(undefined)).toBe('NULL');
  });
  it('refuses NUL characters, non-finite numbers and objects', () => {
    expect(() => literal('a\0b')).toThrow(/NUL/);
    expect(() => literal(Number.NaN)).toThrow();
    expect(() => literal(Infinity)).toThrow();
    expect(() => literal({})).toThrow();
  });
});

describe('statements', () => {
  it('keeps every statement under the D1 limit', async () => {
    const many = Array.from({ length: 3000 }, (_, index) =>
      asDefault(scryfallCard(`Card ${index}`, { oracle_text: 'Long rules text. '.repeat(20) })),
    );
    const rows = await buildRows(many);
    const statements = upsertStatements('cards', rows.cards);
    expect(statements.length).toBeGreaterThan(1);
    for (const statement of statements) {
      expect(new TextEncoder().encode(statement).length).toBeLessThanOrEqual(MAX_STATEMENT_BYTES);
    }
    expect(statements.join('').match(/\('card-\d+-oracle'/g)).toHaveLength(3000);
  });

  it('refuses a row too large for one statement', async () => {
    const rows = await buildRows([asDefault(scryfallCard('Huge', { oracle_text: 'x'.repeat(MAX_STATEMENT_BYTES) }))]);
    expect(() => upsertStatements('cards', rows.cards)).toThrow(/statement limit/);
  });

  it('upserts on the key and keeps the rowid (no INSERT OR REPLACE)', async () => {
    const rows = await buildRows([asDefault(solRing)]);
    const [statement] = upsertStatements('cards', rows.cards);
    expect(statement).toMatch(/^INSERT INTO cards \(oracle_id, /);
    expect(statement).toMatch(
      /ON CONFLICT \(oracle_id\) DO UPDATE SET name = excluded\.name, .*hash = excluded\.hash;$/,
    );
    expect(statement).not.toMatch(/OR REPLACE/);
  });

  it('deletes in batches', () => {
    expect(deleteStatements('prices', ['a', "b'c"])).toEqual([
      "DELETE FROM prices WHERE printing_id IN ('a', 'b''c');",
    ]);
    expect(deleteStatements('prices', [])).toEqual([]);
  });

  it('orders an ingest so the search index never points at a missing card', () => {
    const diff = {
      cards: { upserts: [{ oracle_id: 'new', hash: 'h' }], deletes: ['gone'] },
      printings: { upserts: [], deletes: [] },
      prices: { upserts: [], deletes: [] },
    };
    const statements = ingestStatements(diff, { ingested_at: 'now' });
    const position = (pattern) => statements.findIndex((statement) => pattern.test(statement));
    expect(position(/DELETE FROM cards_fts .*'gone'/)).toBeLessThan(position(/DELETE FROM cards WHERE/));
    expect(position(/INSERT INTO cards \(/)).toBeLessThan(position(/INSERT INTO cards_fts .*'new'/));
    expect(statements.at(-1)).toMatch(/^INSERT INTO card_data_meta/);
    expect(statements.join('\n')).not.toMatch(/BEGIN|COMMIT/);
  });

  it('chunks statements into files', () => {
    // Each statement takes its length plus a newline: 3 bytes here.
    const files = chunkStatements(['a;', 'b;', 'c;'], 6);
    expect(files).toEqual(['a;\nb;\n', 'c;\n']);
  });
});

describe('textLines', () => {
  it('splits chunks into lines across chunk boundaries', async () => {
    async function* chunks() {
      yield '{"a":1}\n{"b"';
      yield ':2}\n\n{"c":3}';
    }
    const lines = [];
    for await (const line of textLines(chunks())) lines.push(line);
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });
});

describe('toCard', () => {
  it('reads double-faced cards from their faces', () => {
    const delver = scryfallCard('Delver of Secrets // Insectile Aberration', {
      type_line: undefined,
      oracle_text: undefined,
      mana_cost: undefined,
      cmc: 1,
      card_faces: [
        {
          name: 'Delver of Secrets',
          type_line: 'Creature — Human Wizard',
          oracle_text: 'Transform it.',
          mana_cost: '{U}',
        },
        { name: 'Insectile Aberration', type_line: 'Creature — Human Insect', oracle_text: 'Flying' },
      ],
    });
    const card = toCard(delver, BUILT);
    expect(card).toMatchObject({
      name: 'Delver of Secrets // Insectile Aberration',
      frontName: 'Delver of Secrets',
      typeLine: 'Creature — Human Wizard // Creature — Human Insect',
      frontType: 'Creature — Human Wizard',
      oracleText: 'Transform it.\nFlying',
      manaCost: '{U}',
      manaValue: 1,
    });
  });

  it('reads missing optional fields as empty or null', () => {
    const bare = { id: 'x', oracle_id: 'y', name: 'Bare', set: 'tst', collector_number: '1' };
    expect(toCard(bare, BUILT)).toMatchObject({
      manaCost: '',
      manaValue: 0,
      keywords: [],
      colorIdentity: [],
      legalities: {},
      gameChanger: false,
      rarity: null,
      edhrecRank: null,
      prices: { usd: null, usdFoil: null, usdEtched: null, eur: null },
    });
  });
});
