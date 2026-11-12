// deck:verify: whether a deck is ready to hand off. It gathers deck:check's findings and adds what a
// finished deck also needs: a game plan, complete stats, a reason for every top left-out card, upgrades
// within budget, decklist files and lowest_legal_bracket that match deck.yaml, and a plays_like_bracket
// judged for the current list. Framework gaps are notes, since a deck may
// depart from a template for a reason it explains.
import { PRIMER_PLACEHOLDER } from './deck.mjs';
import { checkDeck, lowestLegalBracket, error, incomplete, note, outcomeOf } from './rules.mjs';
import { deckCandidates } from './search.mjs';
import { deckStats } from './stats.mjs';
import { CENTS_PER_UNIT, upgradeReport } from './upgrades.mjs';

// A gap between the deck's lands and Karsten's suggestion larger than this needs explaining.
const LAND_GAP = 1;

const primerFindings = (deck) =>
  deck.primer.trim() === PRIMER_PLACEHOLDER ? [error('primer: still the placeholder; describe the game plan')] : [];

function statsFindings(stats) {
  const findings = stats.problems.map((problem) => incomplete(`stats: ${problem}`));
  if (stats.suggestedLands !== null && Math.abs(stats.lands - stats.suggestedLands) > LAND_GAP) {
    findings.push(
      note(
        `lands: ${stats.lands} against Karsten's ~${stats.suggestedLands.toFixed(1)}; explain the gap in power_notes or notes`,
      ),
    );
  }
  for (const { role, count, min, max, status } of stats.roleTargets.targets) {
    if (status === 'within') continue;
    const range = max === null ? `${min}+` : `${min}–${max}`;
    findings.push(note(`roles: ${role} ${count} is ${status} ${range} (${stats.roleTargets.source})`));
  }
  return findings;
}

function candidateFindings({ results, unresolvedRows }, limit) {
  const unexplained = results
    .slice(0, limit)
    .filter((result) => !result.considered)
    .map((result) => result.card.name);
  const findings = unexplained.length
    ? [
        error(
          `candidates: ${unexplained.length} of the top ${limit} left-out cards have no considered reason: ${unexplained.join(', ')}`,
        ),
      ]
    : [];
  if (unresolvedRows) findings.push(incomplete(`candidates: ${unresolvedRows} collection rows have no card data`));
  return findings;
}

function upgradeFindings(deck, collections, index, now) {
  if (!deck.upgrades?.length) return [];
  if (!deck.budget) return [error('upgrades: set budget so deck:upgrades can price them')];
  const report = upgradeReport(deck, collections, index, { now });
  const money = (cents) => (cents / CENTS_PER_UNIT).toFixed(2);
  const total = `${money(report.totalCents)} of ${money(report.budgetCents)} ${report.currency}`;
  if (report.outcome === 'fail') return [error(`upgrades: ${total} budget; cut or reorder the swaps`)];
  if (report.outcome === 'incomplete') return [incomplete(`upgrades: ${total} budget with some prices unknown`)];
  return [];
}

// lowest_legal_bracket is written from the cards, so a different value means the list changed since.
// plays_like_bracket is judged by a reviewer, and deck:files removes it when the cards change.
function bracketFieldFindings(deck, index) {
  const bracket = lowestLegalBracket(deck, index);
  if (bracket === undefined) {
    const stray = ['lowest_legal_bracket', 'plays_like_bracket'].filter((key) => deck[key] !== undefined);
    return stray.length ? [error(`${stray.join(', ')}: only commander formats have brackets`)] : [];
  }
  const findings = [];
  if (bracket !== deck.lowest_legal_bracket) {
    const was = deck.lowest_legal_bracket === undefined ? "isn't set" : `is ${deck.lowest_legal_bracket}`;
    findings.push(error(`lowest_legal_bracket: ${was}, but the cards set ${bracket}; run deck:files`));
  }
  if (deck.plays_like_bracket === undefined) {
    findings.push(
      error(
        'plays_like_bracket: not judged for this list; judge how the deck plays (speed, tutors, fast mana, combos, interaction) and record it, with the reasons in power_notes',
      ),
    );
  }
  return findings;
}

// expected maps each decklist file to the text deck:files would write, or null where it would remove
// the file; actual maps each to the file on disk, or null.
function decklistFindings(expected, actual) {
  const stale = [...expected.keys()].filter((file) => expected.get(file) !== actual.get(file));
  return stale.length ? [error(`decklist files: ${stale.join(', ')} differ from deck.yaml; run deck:files`)] : [];
}

export function verifyDeck({ deck, collections, index, limit, decklists, now = Date.now() }) {
  const check = checkDeck(deck, collections, index, { now });
  const findings = [
    ...check.findings,
    ...primerFindings(deck),
    ...statsFindings(deckStats(deck, index)),
    ...candidateFindings(deckCandidates(deck, collections, index), limit),
    ...upgradeFindings(deck, collections, index, now),
    ...decklistFindings(decklists.expected, decklists.actual),
    ...bracketFieldFindings(deck, index),
  ];
  return { total: check.total, findings, outcome: outcomeOf(findings) };
}
