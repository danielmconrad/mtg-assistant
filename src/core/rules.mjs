import { ageInDays, hasCommanderText, isBackground, isBasic, isLegendaryCreature } from './card.mjs';
import { availableCopies, holdingsNote, ownedCounts, protectedHoldings } from './collection.mjs';
import { ROLE_VOCABULARY, applyUpgrades, deckEntries, resolveEntries, roleLabels } from './deck.mjs';
import { FORMATS, isCommanderFormat } from './formats.mjs';
import { CENTS_PER_UNIT, cheapestQuote } from './upgrades.mjs';

const RULES_WARN_AGE_DAYS = 30;
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const ANY_NUMBER_TEXT = /A deck can have any number of cards named /i;
const UP_TO_TEXT = /A deck can have up to (\w+) cards named /i;
const CUSTOM_LIMIT_TEXT = /A deck can have /i;

// A finding is one line of check output; its level decides the outcome.
const finding = (level) => (message) => ({ level, message });
export const error = finding('error');
export const incomplete = finding('incomplete');
export const note = finding('note');

// Failures outrank unknowns: a deck with both still fails.
const OUTCOME_SEVERITY = ['pass', 'incomplete', 'fail'];

export function outcomeOf(findings) {
  if (findings.some(({ level }) => level === 'error')) return 'fail';
  if (findings.some(({ level }) => level === 'incomplete')) return 'incomplete';
  return 'pass';
}

// The outcome of the deck as it stands, leaving out findings only its unapplied upgrades cause; deck:build
// and a built deck's deck:swap move the baseline's cards, so upgrades can't block them.
export const baselineOutcome = ({ findings }) => outcomeOf(findings.filter((item) => !item.upgrades));

export const worstOutcome = (outcomes) =>
  outcomes.reduce(
    (worst, outcome) => (OUTCOME_SEVERITY.indexOf(outcome) > OUTCOME_SEVERITY.indexOf(worst) ? outcome : worst),
    'pass',
  );

// Returns the most copies allowed, or null when the card prints a rule this checker doesn't parse.
function copyLimit(card, format) {
  if (isBasic(card) || ANY_NUMBER_TEXT.test(card.oracleText)) return Infinity;
  const upTo = card.oracleText.match(UP_TO_TEXT);
  if (upTo) return NUMBER_WORDS[upTo[1].toLowerCase()] ?? Number(upTo[1]);
  if (CUSTOM_LIMIT_TEXT.test(card.oracleText)) return null;
  return FORMATS[format].copyLimit;
}

function sizeFindings(format, total) {
  const { label, size, minSize } = FORMATS[format];
  if (size !== undefined && total !== size) {
    return [error(`${label} requires ${size} cards including commanders; found ${total}`)];
  }
  if (minSize !== undefined && total < minSize) {
    return [error(`${label} requires at least ${minSize} cards; found ${total}`)];
  }
  return [];
}

const hasKeyword = (card, keyword) => card.keywords.includes(keyword);
const isTimeLordDoctor = (card) => /Time Lord Doctor$/.test(card.frontType);
const hasPlainPartner = (card) => /^Partner(?:\s*\(|\s*$)/m.test(card.oracleText);
const partnersWith = (card, other) => card.oracleText.includes(`Partner with ${other.name}`);
const leadsPairWith = (leader, other) =>
  (hasKeyword(leader, 'Choose a Background') && isBackground(other)) ||
  (hasKeyword(leader, "Doctor's companion") && isTimeLordDoctor(other));

function isRecognizedPairing(first, second) {
  return (
    (hasPlainPartner(first) && hasPlainPartner(second)) ||
    (hasKeyword(first, 'Friends forever') && hasKeyword(second, 'Friends forever')) ||
    (partnersWith(first, second) && partnersWith(second, first)) ||
    leadsPairWith(first, second) ||
    leadsPairWith(second, first)
  );
}

// A Background is only eligible as the second half of a pair.
function isEligibleCommander(card, commanderCount) {
  const isPairedBackground = commanderCount === 2 && isBackground(card);
  return isLegendaryCreature(card) || isPairedBackground || hasCommanderText(card);
}

function commanderFindings(commanders) {
  const findings = commanders
    .filter((card) => !isEligibleCommander(card, commanders.length))
    .map((card) => error(`${card.name}: not an eligible commander`));
  if (commanders.length !== 2) return findings;
  const [first, second] = commanders;
  if (first.oracleId === second.oracleId) return [...findings, error('Two commanders must be different cards')];
  if (!isRecognizedPairing(first, second)) {
    return [...findings, incomplete(`${first.name} + ${second.name}: pairing not recognized; verify it manually`)];
  }
  return findings;
}

function copyLimitFindings({ card, quantity }, format) {
  const limit = copyLimit(card, format);
  if (limit === null) return [incomplete(`${card.name}: unusual copy-limit text; verify manually`)];
  if (quantity > limit) return [error(`${card.name}: ${quantity} copies exceeds limit ${limit}`)];
  return [];
}

function commanderLegalityFindings(card, identity, format) {
  const { legality: legalityKey, label } = FORMATS[format];
  const legality = card.legalities[legalityKey];
  const findings = [];
  if (!legality) findings.push(incomplete(`${card.name}: ${label} legality unknown`));
  else if (legality !== 'legal') findings.push(error(`${card.name}: ${legality} in ${label}`));
  if (identity && card.colorIdentity.some((color) => !identity.has(color))) {
    findings.push(error(`${card.name}: outside commander color identity`));
  }
  return findings;
}

function ownershipFindings(tallies, collections, index, deck) {
  const policy = { allowProxies: deck.allow_proxies };
  const owned = ownedCounts(collections.available, index, policy);
  const holdings = protectedHoldings(collections.protected, index, policy);
  const findings = owned.unresolvedRows
    ? [
        incomplete(
          `${owned.unresolvedRows} available collection rows have no cached card data; ownership may be understated (run scryfall:refresh)`,
        ),
      ]
    : [];
  for (const { card, quantity } of tallies.values()) {
    const available = availableCopies(owned, card, { unlimitedBasics: deck.unlimited_basics });
    if (quantity <= available) continue;
    const protectedNote = holdings.has(card.oracleId)
      ? `; ${holdingsNote(holdings.get(card.oracleId))} (protected)`
      : '';
    findings.push(
      error(`${card.name}: need ${quantity}, ${available} available (short ${quantity - available})${protectedNote}`),
    );
  }
  return findings;
}

// Wizards' Commander Brackets (beta; definitions from October 2025). Only some of a bracket's limits
// show in the cards: Game Changers (none in Brackets 1-2, up to 3 in Bracket 3), extra turns (none in
// Bracket 1) and mass land denial (none below Bracket 4). Two-card combos, chained extra turns and a
// deck's intent don't, so the bracket the cards set is a floor, not a rating.
// Checked against every Commander-legal card: "except ... lands" (Scourglass), one tapped land and
// "this land doesn't untap" (painlands) don't count, nor do cards that only stop extra turns.
const MASS_LAND_DENIAL =
  /\b(?:destroy|exile|return) all\b(?:(?!\bexcept\b)[^.])*\blands\b|\beach (?:player|opponent) sacrifices\b[^.]*\blands\b|\blands (?:don't|do not) untap\b|\bcan't untap more than (?:one|two) (?:lands?|permanents?)\b|\bnonbasic lands are\b/i;
const EXTRA_TURN = /\btakes? (?:an|one|two|three|x|that many)? ?extra turns?\b/i;

// The lowest bracket a list's cards allow, with what raises it: [{ bracket, reason }].
export function bracketFloor(tallies) {
  const cards = [...tallies.values()].map(({ card }) => card);
  const named = (test) => cards.filter(test).map((card) => card.name);
  const changers = named((card) => card.gameChanger);
  const landDenial = named((card) => MASS_LAND_DENIAL.test(card.oracleText));
  const extraTurns = named((card) => EXTRA_TURN.test(card.oracleText));
  const raises = [
    ...(changers.length
      ? [
          {
            bracket: changers.length > 3 ? 4 : 3,
            reason: `${changers.length} Game Changers: ${changers.join(', ')}`,
            gameChangers: true,
          },
        ]
      : []),
    ...(landDenial.length ? [{ bracket: 4, reason: `mass land denial: ${landDenial.join(', ')}` }] : []),
    ...(extraTurns.length ? [{ bracket: 2, reason: `extra turns: ${extraTurns.join(', ')}` }] : []),
  ];
  return { bracket: Math.max(1, ...raises.map(({ bracket }) => bracket)), raises };
}

// What lowest_legal_bracket should hold: the bracket a commander deck's cards set, commanders included, or
// undefined for casual decks, which have none.
export function lowestLegalBracket(deck, index) {
  if (!isCommanderFormat(deck.format)) return undefined;
  return bracketFloor(resolveEntries(deckEntries(deck), index).tallies).bracket;
}

// The cards' bracket against target_bracket. Without a target the floor is a note. Bracket 1 lets a
// playgroup agree on thematic Game Changers before the game, so those are a judgment call there.
function bracketFindings(tallies, target) {
  const { bracket, raises } = bracketFloor(tallies);
  const reasons = (list) => list.map(({ reason }) => reason).join('; ');
  if (target === undefined) {
    return raises.length
      ? [note(`Bracket ${bracket} or higher by its cards (${reasons(raises)}); set target_bracket to enforce`)]
      : [];
  }
  const over = raises.filter((raise) => raise.bracket > target);
  if (!over.length) return [];
  const message = `Bracket ${bracket} or higher by its cards (${reasons(over)}); target_bracket is ${target}`;
  if (target === 1 && over.every((raise) => raise.gameChangers)) {
    return [incomplete(`${message}, unless your playgroup agrees to a thematic exception`)];
  }
  return [error(message)];
}

// plays_like_bracket is a judgment, but it can't sit below what the cards require, and a deck that
// plays above the bracket agreed with the playgroup doesn't fit it.
function playsLikeFindings(deck, tallies) {
  const playsLike = deck.plays_like_bracket;
  if (playsLike === undefined) return [];
  const findings = [];
  const lowest = bracketFloor(tallies).bracket;
  if (playsLike < lowest) {
    findings.push(
      error(`plays_like_bracket ${playsLike} is below lowest_legal_bracket ${lowest}, which its cards require`),
    );
  }
  if (deck.target_bracket !== undefined && playsLike > deck.target_bracket) {
    findings.push(error(`plays_like_bracket ${playsLike} is above target_bracket ${deck.target_bracket}`));
  }
  return findings;
}

// The most one card may cost: the deck's max_card_price, else its format's cap, else undefined.
export const priceCap = (deck) => deck.max_card_price ?? FORMATS[deck.format].priceCap;

const formatMoney = (cents, currency) => `${(cents / CENTS_PER_UNIT).toFixed(2)} ${currency}`;

// Judges each card by its cheapest printing, so a pricey printing in the collection doesn't break the cap.
// Upgrade adds are checked too, since applying them must keep the deck under the cap.
function priceCapFindings(deck, tallies, index, now) {
  const cap = priceCap(deck);
  if (!cap) return [];
  const { amount, currency } = cap;
  const capName = deck.max_card_price ? 'max_card_price' : `the ${FORMATS[deck.format].label} cap`;
  const capCents = Math.round(amount * CENTS_PER_UNIT);
  const upgradeCards = (deck.upgrades ?? []).map(({ add }) => index.lookup(add).card).filter(Boolean);
  const cards = new Map([...tallies.values()].map(({ card }) => [card.oracleId, card]));
  for (const card of upgradeCards) cards.set(card.oracleId, card);
  return [...cards.values()]
    .filter((card) => !isBasic(card))
    .flatMap((card) => {
      const quote = cheapestQuote(index, { card }, { currency, now });
      if (quote.problem) return [incomplete(`${card.name}: price cap unchecked; ${quote.problem}`)];
      if (quote.unitCents <= capCents) return [];
      return [
        error(
          `${card.name}: cheapest printing ${formatMoney(quote.unitCents, currency)} exceeds ${capName} ${formatMoney(capCents, currency)}`,
        ),
      ];
    });
}

// deck:stats and the Archidekt export count roles by label, so a label outside the vocabulary is noted.
function roleLabelFindings(deck) {
  const unknown = new Map();
  for (const entry of [...deck.mainboard, ...(deck.upgrades ?? []).map(({ add }) => add)]) {
    for (const label of roleLabels(entry).filter((role) => !ROLE_VOCABULARY.includes(role))) {
      unknown.set(label, [...(unknown.get(label) ?? []), entry.name]);
    }
  }
  return [...unknown].map(([label, names]) =>
    note(`Role "${label}" isn't one of ${ROLE_VOCABULARY.join(', ')}: ${names.join(', ')}`),
  );
}

function freshnessFindings(tallies, now) {
  const oldestDays = Math.max(0, ...[...tallies.values()].map(({ card }) => ageInDays(card, now)));
  if (oldestDays <= RULES_WARN_AGE_DAYS) return [];
  return [
    note(`Card data is ${Math.floor(oldestDays)} days old; run scryfall:refresh to pick up recent bans and errata`),
  ];
}

const findingKey = (item) => `${item.level}:${item.message}`;
const uniqueFindings = (findings) => [...new Map(findings.map((item) => [findingKey(item), item])).values()];

// Card rules for a list: copy limits, and for commander formats legality, color identity and Game Changers.
function listRuleFindings(tallies, deck, identity) {
  const commanderRules = isCommanderFormat(deck.format);
  return [
    ...[...tallies.values()].flatMap((tally) => [
      ...copyLimitFindings(tally, deck.format),
      ...(commanderRules ? commanderLegalityFindings(tally.card, identity, deck.format) : []),
    ]),
    ...(commanderRules ? bracketFindings(tallies, deck.target_bracket) : []),
  ];
}

// Applying the upgrades must keep the deck legal, so the card rules are judged again on the upgraded
// list. Only findings the baseline doesn't already have are reported, marked as coming from upgrades.
function upgradeRuleFindings(deck, index, identity, baseline) {
  if (!deck.upgrades?.length) return [];
  let upgraded;
  try {
    upgraded = applyUpgrades(deck);
  } catch (problem) {
    return [error(`Upgrades: ${problem.message}`)];
  }
  const entries = [...upgraded.commanders, ...upgraded.mainboard, ...upgraded.upgradesIn];
  const { tallies, problems } = resolveEntries(entries, index);
  const seen = new Set(baseline.map(findingKey));
  return [...problems.map(incomplete), ...listRuleFindings(tallies, deck, identity)]
    .filter((item) => !seen.has(findingKey(item)))
    .map((item) => ({ ...item, upgrades: true, message: `With upgrades applied: ${item.message}` }));
}

export function checkDeck(deck, collections, index, { now = Date.now() } = {}) {
  const entries = deckEntries(deck);
  const total = entries.reduce((sum, entry) => sum + entry.quantity, 0);
  const { tallies, problems } = resolveEntries(entries, index);
  const commanders = deck.commanders.map((entry) => index.lookup(entry).card).filter(Boolean);
  const commanderRules = isCommanderFormat(deck.format);
  const identity =
    commanderRules && commanders.length === deck.commanders.length
      ? new Set(commanders.flatMap((card) => card.colorIdentity))
      : null;
  const ruleFindings = listRuleFindings(tallies, deck, identity);
  const findings = uniqueFindings([
    ...problems.map(incomplete),
    ...sizeFindings(deck.format, total),
    ...commanderFindings(commanders),
    ...ruleFindings,
    ...(isCommanderFormat(deck.format) ? playsLikeFindings(deck, tallies) : []),
    ...ownershipFindings(tallies, collections, index, deck),
    ...priceCapFindings(deck, tallies, index, now),
    ...upgradeRuleFindings(deck, index, identity, ruleFindings),
    ...roleLabelFindings(deck),
    ...freshnessFindings(tallies, now),
  ]);
  return { total, findings, outcome: outcomeOf(findings) };
}
