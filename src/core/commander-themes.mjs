// What a commander's rules text cares about, and which cards feed it, for collection:commanders. These
// are rough rules-text tests like ROLE_PATTERNS in search.mjs: they find leads to read, not a deck.
import { creatureTypes } from './card.mjs';

const textMatches = (pattern) => (card) => pattern.test(card.oracleText);
const typeMatches = (pattern) => (card) => pattern.test(card.typeLine);
const hasKeyword = (keyword) => (card) => card.keywords.includes(keyword);
const either =
  (...tests) =>
  (card) =>
    tests.some((test) => test(card));

// Each theme is the wording a commander uses when it cares about something (cares), and a test for the
// cards that feed it (feeds). A commander that merely makes a Treasure once still "cares" about
// Treasure; the ranking compares against an average collection, so incidental themes rank low.
export const THEMES = [
  {
    name: 'tokens',
    cares: /\bfor each [^.]*token|whenever [^.]*\btokens?\b|tokens? you control|populate/i,
    feeds: textMatches(/\bcreate\b[^.]*\btokens?\b|populate|\bamass\b/i),
  },
  {
    name: '+1/+1 counters',
    cares: /\+1\/\+1 counters? on|with (?:a|one or more) \+1\/\+1 counters?|proliferate/i,
    feeds: textMatches(/\+1\/\+1 counter|proliferate|\badapt\b|\bevolve\b|\bbolster\b/i),
  },
  {
    name: 'artifacts',
    cares: /\bartifacts? you control|artifact spells?|whenever [^.]*\bartifact\b|for each artifact/i,
    feeds: either(typeMatches(/Artifact/), textMatches(/\bartifacts? you control|artifact spells?/i)),
  },
  {
    name: 'enchantments',
    cares:
      /\benchantments? you control|enchantment spells?|whenever [^.]*\benchantment\b|constellation|for each enchantment/i,
    feeds: either(typeMatches(/Enchantment/), textMatches(/enchantment spells?|enchantments? you control/i)),
  },
  {
    name: 'equipment',
    cares: /\bequipment\b|equipped creature/i,
    feeds: either(typeMatches(/Equipment/), textMatches(/equipped creature|equipment you control/i)),
  },
  {
    name: 'auras',
    cares: /\bauras?\b|enchanted creatures?/i,
    feeds: either(typeMatches(/Aura/), textMatches(/\bauras? you control/i)),
  },
  {
    name: 'graveyard',
    cares: /from your graveyard|cards? in your graveyard|\bmills?\b|leaves? your graveyard/i,
    feeds: textMatches(
      /\bmills?\b|surveil|from your graveyard|cards? in your graveyard|\bdredge|flashback|unearth|\bescape\b|embalm|eternalize|then discard/i,
    ),
  },
  {
    name: 'sacrifice',
    cares:
      /whenever you sacrifice|\bsacrifice (?:a|an|another|one or more) (?:creature|permanent|artifact)|whenever (?:a|another) [^.]*\bdies\b/i,
    feeds: textMatches(
      /\bsacrifice (?:a|an|another|one or more|x)\b|whenever (?:a|another|one or more) [^.]*\bdies?\b/i,
    ),
  },
  {
    name: 'lifegain',
    cares: /whenever you gain life|if you would gain life|lifelink|you gained life/i,
    feeds: either(
      hasKeyword('Lifelink'),
      textMatches(/\byou gain \d+ life|\bgain(?:s)? (?:x|that much) life|\byou gain life|lifelink/i),
    ),
  },
  {
    name: 'spells',
    cares:
      /instant (?:or|and) sorcery|noncreature spells?|whenever you cast (?:an|a) (?:instant|sorcery|noncreature)|magecraft|\bprowess\b/i,
    feeds: either(
      typeMatches(/Instant|Sorcery/),
      textMatches(/magecraft|\bprowess\b|noncreature spells?|instant (?:or|and) sorcery spells?/i),
    ),
  },
  {
    name: 'lands',
    cares:
      /landfall|whenever a land|play an additional land|lands? you control enters|land cards? from your graveyard/i,
    feeds: textMatches(
      /landfall|whenever a land|additional land|search your library for [^.]*\bland|put [^.]*\bland cards?[^.]* onto the battlefield/i,
    ),
  },
  { name: 'treasure', cares: /\btreasures?\b/i, feeds: textMatches(/\btreasures?\b/i) },
  { name: 'food', cares: /\bfoods?\b/i, feeds: textMatches(/\bfoods?\b/i) },
  { name: 'clues', cares: /\bclues?\b|investigate/i, feeds: textMatches(/\bclues?\b|investigate/i) },
  {
    name: 'card draw',
    cares: /whenever you draw|draw your second card|cards? (?:you've )?drawn/i,
    feeds: textMatches(/\bdraws? (?:a|an|one|two|three|x|that many|cards)\b/i),
  },
  {
    name: 'discard',
    cares: /whenever (?:you|a player|an opponent) discards?|discard (?:a|one or more) cards?,/i,
    feeds: textMatches(/\bdiscards?\b|\bmadness\b/i),
  },
  {
    name: 'blink',
    cares:
      /\bexile [^.]*\breturn (?:it|that card|them|those cards) to the battlefield|whenever another (?:creature|permanent|nontoken creature) (?:you control )?enters/i,
    feeds: textMatches(/exile [^.]*return [^.]*to the battlefield|\bflicker/i),
  },
  {
    name: 'go wide',
    cares: /whenever (?:one or more|a|another) creatures? you control attacks?|attacking creatures you control/i,
    feeds: textMatches(
      /whenever (?:one or more|a|another) creatures? you control attacks?|attacking creatures|creatures you control get \+|\bmyriad\b|\bbattle cry\b|\bmelee\b/i,
    ),
  },
  {
    name: 'combat damage',
    cares: /deals combat damage to (?:a player|an opponent|one or more players)/i,
    feeds: textMatches(/deals combat damage to (?:a player|an opponent)|can't be blocked|\bmenace\b/i),
  },
  { name: 'flying', cares: /creatures? (?:you control )?with flying|flying creatures?/i, feeds: hasKeyword('Flying') },
  {
    name: 'legends',
    cares: /\blegendary (?:creatures?|spells?|permanents?)|\bhistoric\b/i,
    feeds: either(typeMatches(/Legendary/), textMatches(/\bhistoric\b/i)),
  },
  {
    name: 'vehicles',
    cares: /\bvehicles?\b|\bcrews?\b/i,
    feeds: either(typeMatches(/Vehicle/), textMatches(/\bcrew\b/i)),
  },
  {
    name: 'copies',
    cares: /\bcopy (?:target|that|it|a)\b|\bcopies of\b/i,
    feeds: textMatches(/\bcopy (?:target|that|it)\b|\bbecomes? a copy\b/i),
  },
  {
    name: 'poison',
    cares: /poison counters?|infect|\btoxic\b/i,
    feeds: either(hasKeyword('Infect'), hasKeyword('Toxic'), textMatches(/poison counter|proliferate/i)),
  },
  { name: 'energy', cares: /\{E\}/, feeds: textMatches(/\{E\}/) },
  {
    name: 'big creatures',
    cares: /power (?:4|5|6|7) or greater|greatest power|mana value (?:5|6|7) or greater/i,
    feeds: (card) =>
      card.typeLine.includes('Creature') &&
      (card.manaValue >= 6 || /power (?:4|5|6) or greater/i.test(card.oracleText)),
  },
  {
    name: 'goad',
    cares: /\bgoad|attacks? a player other than you/i,
    feeds: textMatches(/\bgoad|attacks? each combat if able|can't attack you/i),
  },
  { name: 'monarch', cares: /\bmonarch\b|\binitiative\b/i, feeds: textMatches(/\bmonarch\b|\binitiative\b/i) },
  {
    name: 'counterspells',
    cares: /whenever [^.]*counters? a spell|counter target spell/i,
    feeds: textMatches(/counter target (?:spell|noncreature)/i),
  },
  {
    name: 'group draw',
    cares: /each player draws|each opponent draws|whenever an opponent draws/i,
    feeds: textMatches(/each player draws|each opponent draws|target player draws/i),
  },
  {
    name: 'drain',
    cares: /whenever [^.]* deals? (?:noncombat )?damage to an opponent|each opponent loses \d+ life/i,
    feeds: textMatches(/each opponent loses \d+ life|deals? \d+ damage to each opponent/i),
  },
];

// Plurals the rules text uses that aren't the type plus s or es.
const IRREGULAR_PLURALS = {
  Cyclops: 'Cyclopes',
  Dwarf: 'Dwarves',
  Elf: 'Elves',
  Fungus: 'Fungi',
  Mouse: 'Mice',
  Werewolf: 'Werewolves',
  Wolf: 'Wolves',
};
const pluralOf = (type) => IRREGULAR_PLURALS[type] ?? (/(?:s|x|ch|sh)$/.test(type) ? `${type}es` : `${type}s`);
// Two-letter types such as Ox are skipped: too easy to match by accident.
const MIN_TYPE_LENGTH = 3;

// Subtypes on faces that aren't creatures or Kindred, such as Equipment, Saga and Food. A Kindred face
// lists them alongside its creature types, so creatureTypes can't tell them apart.
function noncreatureSubtypes(cards) {
  const subtypes = new Set();
  for (const card of cards) {
    for (const face of card.typeLine.split(' // ')) {
      if (/\b(?:Creature|Kindred)\b/.test(face)) continue;
      for (const subtype of (face.split(' — ')[1] ?? '').split(' ').filter(Boolean)) subtypes.add(subtype);
    }
  }
  return subtypes;
}

// The creature types in cards' type lines, and one pattern that finds any of them, singular or plural,
// in rules text.
export function creatureTypeVocabulary(cards) {
  const excluded = noncreatureSubtypes(cards);
  const types = new Set(
    cards.flatMap(creatureTypes).filter((type) => type.length >= MIN_TYPE_LENGTH && !excluded.has(type)),
  );
  const typeOf = new Map(
    [...types].flatMap((type) => [
      [type, type],
      [pluralOf(type), type],
    ]),
  );
  const words = [...typeOf.keys()].sort((first, second) => second.length - first.length);
  // Rules text capitalizes creature types, so matching case keeps out words like "wall" and "elder".
  // "non-Human" excludes a type rather than naming it.
  const pattern = new RegExp(`(?<!non-)\\b(?:${words.join('|')})\\b`, 'g');
  return { pattern, typeOf: (word) => typeOf.get(word) };
}

const namedTypes = (text, vocabulary) =>
  new Set([...text.matchAll(vocabulary.pattern)].map(([word]) => vocabulary.typeOf(word)));

// The names a card's rules text calls it by: each face's full name and the part before a comma
// ("Spider-Man" for Spider-Man, New Champion), longest first.
const selfNames = (card) =>
  [...new Set(card.name.split(' // ').flatMap((name) => [name, name.split(',')[0]]))].sort(
    (first, second) => second.length - first.length,
  );

// The creature types a commander's text names, leaving out its own name (Spider-Man isn't about
// Spiders) and the tokens it creates (making a 1/1 Soldier isn't a Soldier deck).
export function commanderTribes(card, vocabulary) {
  const text = selfNames(card)
    .reduce((rest, name) => rest.replaceAll(name, ''), card.oracleText)
    .replace(/\bcreate\b[^.]*\./gi, '');
  return [...namedTypes(text, vocabulary)];
}

// The creature types a card has, makes or names, for counting it toward a tribal commander. A
// changeling has every type, recorded as '*'.
export function tribesFed(card, vocabulary) {
  const tribes = namedTypes(card.oracleText, vocabulary);
  for (const type of creatureTypes(card)) tribes.add(type);
  if (card.keywords.includes('Changeling')) tribes.add('*');
  return tribes;
}

// The themes a commander cares about, by index into THEMES.
export const commanderThemeIndexes = (card) =>
  THEMES.flatMap((theme, position) => (theme.cares.test(card.oracleText) ? [position] : []));
