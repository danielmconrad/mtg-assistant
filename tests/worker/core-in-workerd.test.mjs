// Every src/core module loads and runs inside workerd: no Node built-ins, no runtime code generation
// (the deck validator is compiled ahead of time), and the CSV and YAML parsers work here.
import { describe, expect, it } from 'vitest';
import * as cardReport from '../../src/core/card-report.mjs';
import * as commanderThemes from '../../src/core/commander-themes.mjs';
import * as commanders from '../../src/core/commanders.mjs';
import { parseCollection, parseTextCollection } from '../../src/core/collection.mjs';
import { parseDeck, validateDeck } from '../../src/core/deck.mjs';
import * as edhrec from '../../src/core/edhrec.mjs';
import { exportDeck } from '../../src/core/export.mjs';
import * as format from '../../src/core/format.mjs';
import * as json from '../../src/core/json.mjs';
import * as rules from '../../src/core/rules.mjs';
import * as search from '../../src/core/search.mjs';
import * as stats from '../../src/core/stats.mjs';
import * as upgrades from '../../src/core/upgrades.mjs';
import * as verify from '../../src/core/verify.mjs';

const DECK_YAML = `schema_version: 1
name: Bears
format: commander
status: draft
allow_proxies: false
primer: Bears.
commanders:
  - name: Ayula, Queen Among Bears
    quantity: 1
mainboard:
  - name: Forest
    quantity: 99
    role: land
`;

describe('src/core in workerd', () => {
  it('loads every module', () => {
    for (const module of [
      cardReport,
      commanderThemes,
      commanders,
      edhrec,
      format,
      json,
      rules,
      search,
      stats,
      upgrades,
      verify,
    ]) {
      expect(Object.keys(module).length).toBeGreaterThan(0);
    }
  });

  it('parses a ManaBox CSV with csv-parse', () => {
    const csv =
      'Name,Quantity,Scryfall ID,Set code,Collector number,Foil,Proxy\n' +
      'Sol Ring,2,25ef2d44-c261-4511-b96f-85e7a291e318,C21,263,normal,false\n';
    expect(parseCollection(csv, 'binder')).toMatchObject([{ name: 'Sol Ring', quantity: 2, finish: 'normal' }]);
  });

  it('parses a text list', () => {
    expect(parseTextCollection('1 Sol Ring (C21) 263 *F*', 'list')).toMatchObject([
      { name: 'Sol Ring', set: 'c21', collectorNumber: '263', finish: 'foil' },
    ]);
  });

  it('parses and validates a deck with the precompiled validator', () => {
    const deck = parseDeck(DECK_YAML, 'bears');
    expect(deck.commanders[0].name).toBe('Ayula, Queen Among Bears');
    // An empty name fails minLength, which the inlined code-point counter checks.
    expect(() => validateDeck({ ...deck, name: '' }, 'bears')).toThrow(
      /bears: \/name must NOT have fewer than 1 characters/,
    );
    expect(() => validateDeck({ ...deck, format: 'vintage' }, 'bears')).toThrow(
      /\/format must be equal to one of the allowed values/,
    );
  });

  it('exports a decklist', () => {
    const text = exportDeck(parseDeck(DECK_YAML), { format: 'moxfield' });
    expect(text).toContain('1 Ayula, Queen Among Bears');
    expect(text).toContain('99 Forest');
  });
});
