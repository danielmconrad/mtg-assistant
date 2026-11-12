// In memory a cache is { version, cards }, as mtg-manager's card-cache.mjs read it; the version is unused here.
const CACHE_VERSION = 7;
import { cardIndex } from '../../src/core/card-index.mjs';

export const NOW = Date.parse('2026-10-15T12:00:00Z');
export const DAY_MS = 86_400_000;

// A cached card in the project's card model; IDs derive from the name unless overridden.
export function card(name, fields = {}) {
  const slug = name.toLowerCase().replace(/\W+/g, '-');
  const typeLine = fields.typeLine ?? 'Sorcery';
  return {
    id: `${slug}-print`,
    oracleId: slug,
    name,
    frontName: name,
    set: 'tst',
    collectorNumber: '1',
    manaCost: '',
    manaValue: 0,
    typeLine,
    frontType: typeLine,
    flavorName: null,
    oracleText: '',
    keywords: [],
    colorIdentity: [],
    producedMana: [],
    legalities: { commander: 'legal' },
    gameChanger: false,
    borderColor: 'black',
    setType: 'expansion',
    edhrecRank: null,
    prices: { usd: '1.00', eur: null },
    defaultPrinting: false,
    fetchedAt: new Date(NOW).toISOString(),
    ...fields,
  };
}

export const forest = card('Forest', {
  typeLine: 'Basic Land — Forest',
  colorIdentity: ['G'],
  producedMana: ['G'],
  prices: { usd: '0.20', eur: null },
});
export const leader = card('Example Leader', {
  typeLine: 'Legendary Creature — Elf',
  manaCost: '{2}{G}',
  manaValue: 3,
  colorIdentity: ['G'],
});
export const spell = card('Example Spell', {
  manaCost: '{1}{G}',
  manaValue: 2,
  colorIdentity: ['G'],
  prices: { usd: '2.50', eur: null },
});

export const cacheOf = (...cards) => ({
  version: CACHE_VERSION,
  cards: Object.fromEntries(cards.map((value) => [value.id, value])),
});
export const indexOf = (...cards) => cardIndex(cacheOf(...cards));
export const row = (value, quantity, { isProxy = false, collection = 'Organized' } = {}) => ({
  name: value.name,
  quantity,
  scryfallId: value.id,
  isProxy,
  collection,
});
export const entry = (name, quantity = 1, extra = {}) => ({ name, quantity, ...extra });
export const messages = (report, level) =>
  report.findings.filter((item) => item.level === level).map((item) => item.message);
