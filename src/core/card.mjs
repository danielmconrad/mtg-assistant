// The card model shared by every module: one printing, in this project's camelCase vocabulary.
// See toCard in scryfall.mjs for the fields.

const DAY_MS = 86_400_000;

export const normalizeName = (name) => name.trim().toLocaleLowerCase('en-US');

export const hasName = (card, name) =>
  [card.name, card.frontName].some((candidate) => normalizeName(candidate) === normalizeName(name));

export const isBasic = (card) => /\bBasic\b/.test(card.frontType);

export const isLand = (card) => card.frontType.includes('Land');

export const isLegendaryCreature = (card) =>
  card.frontType.includes('Legendary') && card.frontType.includes('Creature');

export const isPlaneswalker = (card) => card.frontType.includes('Planeswalker');

export const isBackground = (card) => card.frontType.includes('Background');

export const hasCommanderText = (card) => card.oracleText.includes('can be your commander');

// A printed power/toughness box on the front face. Card data from before these fields were recorded has none.
export const hasPowerToughness = (card) =>
  card.power !== null && card.power !== undefined && card.toughness !== null && card.toughness !== undefined;

// Since Edge of Eternities (2025), a legendary Vehicle or Spacecraft with a power/toughness box can be a commander.
const isLegendaryVehicle = (card) =>
  card.frontType.includes('Legendary') && /\b(?:Vehicle|Spacecraft)\b/.test(card.frontType) && hasPowerToughness(card);

// Can be a commander on its own merits: a legendary creature, a legendary Vehicle or Spacecraft with a
// power/toughness box, or a card that says it can be your commander. Judged on the front face.
export const isCommanderEligible = (card) =>
  isLegendaryCreature(card) || isLegendaryVehicle(card) || hasCommanderText(card);

// Could lead a deck alone or as half of a pair; rules.mjs checks whether a specific pair is legal.
export const canBeCommander = (card) => isCommanderEligible(card) || isBackground(card);

const COLOR_ORDER = 'WUBRG';

// Color identity in WUBRG order, e.g. ['B', 'G']; empty for colorless.
export const orderedIdentity = (card) => [...COLOR_ORDER].filter((color) => card.colorIdentity.includes(color));

// The same as a label, e.g. "BG"; "C" for colorless.
export const identityLabel = (card) => orderedIdentity(card).join('') || 'C';

// Subtypes on every creature or Kindred face: "Legendary Creature — Dwarf Warrior" gives Dwarf and Warrior.
export const creatureTypes = (card) => [
  ...new Set(
    card.typeLine
      .split(' // ')
      .filter((face) => /\b(Creature|Kindred)\b/.test(face))
      .flatMap((face) => (face.split(' — ')[1] ?? '').split(' ').filter(Boolean)),
  ),
];

// Gold-bordered and memorabilia printings (World Championship decks, Collectors' Edition, 30th Anniversary
// Edition) can't be played, so they never set a card's price. A cache from before these fields were
// recorded reads every printing as playable.
export const isPlayablePrinting = (printing) => printing.borderColor !== 'gold' && printing.setType !== 'memorabilia';

export const ageInDays = (card, now) => (now - Date.parse(card.fetchedAt)) / DAY_MS;
