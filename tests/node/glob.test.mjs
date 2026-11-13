import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchesGlob, pathMatches } from '../../src/core/glob.mjs';

// The collection paths and patterns mtg-manager's data used, plus edge cases.
const PATHS = [
  'collections/brad/ManaBox_Collection.csv',
  'collections/conrad/binders/Alphabetized.txt',
  'collections/conrad/protected/precons/Elven Council.txt',
  'collections/conrad/protected/custom/Kwia Lotus Engine.txt',
  'collections/conrad/protected/Valuables.txt',
  'collections/conrad/decks/Turtle Power!.txt',
  'ManaBox_Collection.csv',
  'binders/Alphabetized.txt',
  'protected/precons/World Shaper (upgraded).txt',
  'a.b/c+d/e$f.txt',
];
const GLOBS = [
  'collections/brad/**/*',
  'collections/brad/*',
  'collections/conrad*',
  'collections/**/precons',
  'collections/**/decks',
  'collections/**/protected',
  '**/*',
  '*',
  '**',
  'binders*',
  'protected/**',
  '**/precons/*',
  'collections/?onrad/**',
  'collections/[bc]*/**',
  'collections/[!b]*/**',
  'a.b/*/e$f.txt',
  'protected/precons/World Shaper (upgraded).txt',
];

describe('matchesGlob', () => {
  it.each(PATHS.flatMap((path) => GLOBS.map((glob) => [path, glob])))('%s vs %s agrees with Node', (path, glob) => {
    expect(matchesGlob(path, glob)).toBe(posix.matchesGlob(path, glob));
  });
});

describe('pathMatches', () => {
  it('matches the path, the path without extension, or a folder it sits in', () => {
    expect(pathMatches('binders/Alphabetized.txt', 'binders/Alphabetized')).toBe(true);
    expect(pathMatches('binders/Alphabetized.txt', 'binders')).toBe(true);
    expect(pathMatches('protected/precons/Elven Council.txt', '**/precons')).toBe(true);
    expect(pathMatches('protected/Valuables.txt', '**/precons')).toBe(false);
    expect(pathMatches('ManaBox_Collection.csv', '**/*')).toBe(true);
    expect(pathMatches('ManaBox_Collection.csv', './ManaBox_Collection/')).toBe(true);
  });
});
