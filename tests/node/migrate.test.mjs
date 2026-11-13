import { describe, expect, it } from 'vitest';
import {
  inlineParams,
  isProtectedPath,
  relativeDeck,
  relativePattern,
  sourceRecords,
} from '../../scripts/migrate/plan.mjs';

describe('relativePattern', () => {
  it.each([
    ['collections/brad/**/*', 'brad', 'collections/**/*'],
    ['collections/brad/*', 'brad', 'collections/*'],
    ['collections/brad', 'brad', 'collections'],
    ['collections/brad/', 'brad', 'collections'],
    ['./collections/brad/binders', 'brad', 'collections/binders'],
    ['collections/**/precons', 'conrad', 'collections/**/precons'],
    ['collections/*', 'conrad', 'collections'],
    ['collections/c*/binders', 'conrad', 'collections/binders'],
  ])('%s for %s → %s', (pattern, owner, expected) => {
    expect(relativePattern(pattern, owner)).toEqual({ pattern: expected });
  });

  it("refuses patterns naming another owner's collections", () => {
    expect(relativePattern('collections/conrad/binders', 'brad').problem).toMatch(/outside collections\/brad\//);
    expect(relativePattern('collections/bradley/x', 'brad').problem).toBeDefined();
  });
});

describe('relativeDeck', () => {
  it('rewrites collection_source and collection_destination, reporting what it drops', () => {
    const deck = {
      name: 'Penny',
      collection_source: ['collections/brad/**/*', 'collections/conrad/binders'],
      collection_destination: 'collections/brad/decks/Penny.txt',
    };
    const { deck: converted, problems } = relativeDeck(deck, 'brad', 'penny');
    expect(converted.collection_source).toEqual(['collections/**/*']);
    expect(converted.collection_destination).toBe('collections/decks/Penny.txt');
    expect(problems).toEqual(['penny: collections/conrad/binders names collections outside collections/brad/']);
    expect(deck.collection_source).toHaveLength(2);
  });
});

describe('isProtectedPath', () => {
  it.each([
    ['protected/Valuables.txt', true],
    ['protected/precons/Elven Council.txt', true],
    ['protected/custom/Kwia Lotus Engine.txt', true],
    ['decks/Penny.txt', true],
    ['binders/Alphabetized.txt', false],
    ['ManaBox_Collection.csv', false],
    ['precons.txt', false],
  ])('%s → %s', (path, expected) => {
    expect(isProtectedPath(path)).toBe(expected);
  });
});

describe('sourceRecords', () => {
  it("keeps ManaBox's other columns by row, leaving out the parsed ones", () => {
    const csv =
      '﻿Binder Name,Binder Type,Name,Quantity,Scryfall ID,Set code,Collector number,Foil,Purchase price,Condition\n' +
      'all cards,binder,Sol Ring,1,25ef2d44-c261-4511-b96f-85e7a291e318,C21,263,normal,1.50,near_mint\n\n' +
      'decks,deck,Arcane Signet,2,a6813cd2-7151-459a-a2f1-52808584de53,LTC,273,foil,0.80,played\n';
    expect(sourceRecords(csv).map((record) => JSON.parse(record))).toEqual([
      { 'Binder Name': 'all cards', 'Purchase price': '1.50', Condition: 'near_mint' },
      { 'Binder Name': 'decks', 'Purchase price': '0.80', Condition: 'played' },
    ]);
  });
});

describe('inlineParams', () => {
  it('substitutes literals for placeholders outside quotes', () => {
    expect(inlineParams("SELECT * FROM t WHERE a = ? AND b = '?' AND c IN (?, ?)", ["it's", 2, null])).toBe(
      "SELECT * FROM t WHERE a = 'it''s' AND b = '?' AND c IN (2, NULL)",
    );
  });
  it('refuses a parameter count that does not match', () => {
    expect(() => inlineParams('SELECT ?', [])).toThrow(/Too few/);
    expect(() => inlineParams('SELECT 1', [1])).toThrow(/Too many/);
  });
});
