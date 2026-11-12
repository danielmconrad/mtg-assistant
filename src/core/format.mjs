// Turns reports into the text the CLI prints. Nothing here decides an outcome.
import { identityLabel } from './card.mjs';
import { holdingsNote } from './collection.mjs';
import { CARD_TYPES, CHEAP_MANA_VALUE, CURVE_TOP_BUCKET, MANA_SYMBOLS, OPENING_HAND } from './stats.mjs';
import { CENTS_PER_UNIT, PRICE_MAX_AGE_DAYS } from './upgrades.mjs';

export const printAll = (write, lines) => {
  for (const line of lines) write(line);
};

const OUTCOME_LABELS = { pass: 'PASS', incomplete: 'INCOMPLETE', fail: 'FAIL' };
const LEVEL_LABELS = { error: 'ERROR', incomplete: 'INCOMPLETE', note: 'NOTE' };
const BUDGET_LABELS = { pass: 'WITHIN BUDGET', fail: 'OVER BUDGET', incomplete: 'INCOMPLETE: known prices total' };

const money = (cents, currency) => `${(cents / CENTS_PER_UNIT).toFixed(2)} ${currency}`;
const indent = (line) => `  ${line}`;

export const collectionSummaryLine = (name, isProtected, { rowCount, copies, distinctNames, proxyCopies }) =>
  `${name}${isProtected ? ' (protected)' : ''}: ${rowCount} rows, ${copies} copies, ${distinctNames} distinct names, ${proxyCopies} proxy copies`;

export function checkLines(slug, { total, findings, outcome }) {
  const ordered = Object.keys(LEVEL_LABELS).flatMap((level) => findings.filter((item) => item.level === level));
  return [
    `${OUTCOME_LABELS[outcome]}: ${slug} (${total} cards)`,
    ...ordered.map(({ level, message }) => indent(`${LEVEL_LABELS[level]}: ${message}`)),
  ];
}

// EDHREC rank and cheapest USD price, with ? for unknown, e.g. "EDHREC #1234, $0.25".
const valueNote = ({ edhrecRank, priceUsd }) =>
  `EDHREC ${edhrecRank === null ? '?' : `#${edhrecRank}`}, ${priceUsd === null ? '$?' : `$${priceUsd.toFixed(2)}`}`;

const gameChangerNote = (card) => (card.gameChanger ? ' [Game Changer]' : '');

const oracleLines = (card) => (card.oracleText ? card.oracleText.split('\n').map((line) => `    ${line}`) : []);

// The matched printing, e.g. " {trk 158, uncommon}".
const printingNote = ({ printing }) =>
  printing ? ` {${printing.set} ${printing.collectorNumber}, ${printing.rarity ?? 'rarity unknown'}}` : '';

export function searchLines(results, { withOracleText = false, withValues = false, withPrinting = false } = {}) {
  const lines = results.flatMap((result) => {
    const { card, available, protectedIn } = result;
    const protectedNote = protectedIn.length ? ` (+${holdingsNote(protectedIn)}, protected)` : '';
    const values = withValues ? ` (${valueNote(result)})` : '';
    const printing = withPrinting ? printingNote(result) : '';
    const summary = `${available}x ${card.name} ${card.manaCost} — ${card.typeLine} [${identityLabel(card)}]${gameChangerNote(card)}${printing}${values}${protectedNote}`;
    return [summary, ...(withOracleText ? oracleLines(card) : [])];
  });
  return [...lines, `${results.length} cards`];
}

// deck:candidates: the most valued cards the deck leaves out, each with its considered reason if any.
// The summary counts the shown cards without a reason, since those are the ones a review must cover.
export function candidateLines(results, { limit, withOracleText = false, unresolvedRows = 0, overCap = 0 }) {
  const shown = results.slice(0, limit);
  const unexplained = (list) => list.filter((result) => !result.considered).length;
  const lines = shown.flatMap((result) => {
    const { card, available } = result;
    const summary = `${available}x ${card.name} ${card.manaCost} — ${card.typeLine}${gameChangerNote(card)} (${valueNote(result)})`;
    const reason = result.considered ? `    considered: ${result.considered}` : '    not in considered';
    return [summary, reason, ...(withOracleText ? oracleLines(card) : [])];
  });
  return [
    ...lines,
    `${shown.length} of ${results.length} left-out cards shown; ${unexplained(shown)} of them without a considered reason (${unexplained(results)} in all)`,
    ...(overCap ? [`${overCap} more cost over the deck's price cap and aren't listed`] : []),
    ...(unresolvedRows ? [`${unresolvedRows} collection rows have no cached card data and were skipped`] : []),
  ];
}

function countList(counts, order) {
  const keys = order
    ? order.filter((key) => counts.has(key))
    : [...counts.keys()].sort((first, second) => counts.get(second) - counts.get(first));
  return keys.map((key) => `${key} ${counts.get(key)}`).join(', ') || 'none';
}

const percent = (chance) => `${Math.round(chance * 100)}%`;

function bracketLines(bracket) {
  if (!bracket) return [];
  const raisedBy = bracket.raises.length
    ? bracket.raises.map(({ reason }) => reason).join('; ')
    : 'no Game Changers, extra turns or mass land denial';
  const judged = (value) => (value === null ? 'not set' : value);
  return [
    `Brackets: lowest legal ${bracket.bracket} (${raisedBy}); plays like ${judged(bracket.playsLike)}; target ${judged(bracket.target)}`,
  ];
}

function roleTargetLines({ source, targets }) {
  if (!source) return [];
  const range = ({ min, max }) => (max === null ? `${min}+` : `${min}–${max}`);
  const notes = targets.map(
    (target) =>
      `${target.role} ${target.count} (${range(target)}${target.status === 'within' ? '' : `, ${target.status}`})`,
  );
  return [`Role targets (${source}): ${notes.join(', ')}`];
}

function openingHandLines(odds) {
  if (!odds) return [];
  return [
    `Opening ${OPENING_HAND}: 0–1 lands ${percent(odds.fewLands)}, 2–4 lands ${percent(odds.keepableLands)}, ` +
      `5+ lands ${percent(odds.manyLands)}; at least one ramp card ${percent(odds.someRamp)}`,
  ];
}

export function statsLines(deck, stats, { upgradesApplied = false } = {}) {
  const nonlandCards = stats.cards - stats.lands;
  const averageManaValue = nonlandCards ? (stats.nonlandManaValue / nonlandCards).toFixed(2) : 'n/a';
  const curve = Array.from({ length: CURVE_TOP_BUCKET + 1 }, (_, manaValue) => {
    const label = manaValue === CURVE_TOP_BUCKET ? `${manaValue}+` : manaValue;
    return `${label}:${stats.curve.get(manaValue) ?? 0}`;
  });
  const commanders = deck.commanders.map((entry) => entry.name).join(' + ');
  return [
    `${deck.name}: ${stats.cards} mainboard cards${commanders ? ` + commander ${commanders}` : ''}${upgradesApplied ? ' (upgrades applied)' : ''}`,
    `Lands: ${stats.lands}; nonland average mana value: ${averageManaValue}`,
    ...(stats.suggestedLands === null
      ? []
      : [
          `Karsten suggests ~${stats.suggestedLands.toFixed(1)} lands, counting ${stats.cheapRampAndDraw} cheap ramp/draw ` +
            `(role ramp or draw, mana value ${CHEAP_MANA_VALUE} or less)`,
        ]),
    `Curve (nonland): ${curve.join(' ')}`,
    `Types: ${countList(stats.types, CARD_TYPES)}`,
    `Color pips (nonland): ${countList(stats.pips, MANA_SYMBOLS)}`,
    `Land color sources: ${countList(stats.landSources, MANA_SYMBOLS)}`,
    `Roles: ${countList(stats.roles)}`,
    ...bracketLines(stats.bracket),
    ...roleTargetLines(stats.roleTargets),
    ...openingHandLines(stats.openingHand),
    ...stats.problems.map((problem) => indent(`INCOMPLETE: ${problem}`)),
  ];
}

function purchaseLine({ card, quantity, unitCents, printing, problem }, currency) {
  if (problem) return `${card.name}: buy ${quantity}, price unknown (${problem})`;
  const printingLabel = `${printing.set.toUpperCase()} #${printing.collectorNumber}`;
  return `${card.name}: buy ${quantity} × ${money(unitCents, currency)} (${printingLabel}) = ${money(quantity * unitCents, currency)}`;
}

export function upgradeLines({ currency, purchases, problems, unresolvedRows, totalCents, budgetCents, outcome }) {
  const unresolvedNote = unresolvedRows
    ? [`${unresolvedRows} available collection rows have no cached card data; purchase quantities may be overstated`]
    : [];
  return [
    `Cards the available collections cannot supply, priced at the cheapest cached Scryfall nonfoil ${currency} quote under ${PRICE_MAX_AGE_DAYS} days old. Excludes shipping and tax.`,
    ...[...problems, ...unresolvedNote, ...purchases.map((purchase) => purchaseLine(purchase, currency))].map(indent),
    `${BUDGET_LABELS[outcome]}: ${money(totalCents, currency)} of ${money(budgetCents, currency)} budget`,
  ];
}

export const countLine = ({ cards, copies }, availableNames) =>
  `${cards} cards, ${copies} copies in ${availableNames.join(', ') || 'no available collections'}`;

export function groupLines(groups) {
  const width = Math.max(0, ...groups.map(({ cards }) => String(cards).length));
  const lines = groups.map(({ key, cards, copies }) => `${String(cards).padStart(width)}  ${key} (${copies} copies)`);
  return [...lines, `${groups.length} groups; counts are distinct cards`];
}

// deck:show: the commanders, then the mainboard grouped by each card's first role, with every role named.
export function showLines({ commanders, groups, problems }, { withOracleText = false } = {}) {
  const cardLine = ({ card, quantity, roles, upgrade }) =>
    `${quantity}x ${card.name} ${card.manaCost} — ${card.typeLine}${roles.length ? ` [${roles.join(', ')}]` : ''}${upgrade ? ' (upgrade)' : ''}`;
  const withText = (item) => [cardLine(item), ...(withOracleText ? oracleLines(item.card) : [])];
  return [
    ...commanders.flatMap((item) => [
      `Commander: ${cardLine(item)}`,
      ...(withOracleText ? oracleLines(item.card) : []),
    ]),
    ...groups.flatMap(({ role, items }) => [
      `${role} (${items.reduce((sum, item) => sum + item.quantity, 0)})`,
      ...items.flatMap(withText).map(indent),
    ]),
    ...problems.map((problem) => indent(`INCOMPLETE: ${problem}`)),
  ];
}

const useNote = ({ deck, as, roles, reason }) => {
  if (as === 'mainboard') return `${deck} (mainboard${roles.length ? `: ${roles.join(', ')}` : ''})`;
  if (as === 'considered') return `${deck} (left out: ${reason})`;
  return `${deck} (${as})`;
};

// card:show: each card's text, legality and value, the copies held and where decks use it.
export function cardReportLines(reports) {
  return reports.flatMap((report) => {
    if (report.problem) return [`INCOMPLETE: ${report.problem}`];
    const { card, available, protectedIn, uses, printings } = report;
    const commander = card.legalities.commander ?? 'unknown';
    const copies = protectedIn.length ? `; ${holdingsNote(protectedIn)} (protected)` : '';
    return [
      `${card.name} ${card.manaCost} — ${card.typeLine} [${identityLabel(card)}]${gameChangerNote(card)}`,
      ...oracleLines(card),
      indent(`Commander: ${commander}; ${valueNote(report)}; ${printings} printings cached`),
      indent(`Copies: ${available} available${copies}`),
      indent(`Decks: ${uses.length ? uses.map(useNote).join('; ') : 'none'}`),
    ];
  });
}

const dateOf = (iso) => iso?.slice(0, 10) ?? 'unknown';

// collection:check's line about the card cache.
export function cacheStatusLine({ printings, cards, fromBulk, bulkBuiltAt, refreshedAt, daysSinceRefresh }) {
  const source = fromBulk ? `from bulk data built ${dateOf(bulkBuiltAt)}` : 'collection and deck cards only';
  const age = refreshedAt ? `; last refreshed ${dateOf(refreshedAt)} (${daysSinceRefresh} days ago)` : '';
  const stale =
    daysSinceRefresh > PRICE_MAX_AGE_DAYS
      ? `; prices over ${PRICE_MAX_AGE_DAYS} days old count as unknown, so refresh`
      : '';
  return `Card cache: ${printings} printings of ${cards} cards, ${source}${age}${stale}`;
}

// collection:diff's lines: each changed collection with its card changes (+2 Sol Ring, -1 Forest), at
// most DIFF_CARDS_SHOWN of them, then the decks naming changed cards.
const DIFF_CARDS_SHOWN = 30;
export function collectionDiffLines(ref, changes, decks) {
  if (!changes.length) return [`No collection changes since ${ref}.`];
  const signed = ({ name, change }) => `${change > 0 ? '+' : ''}${change} ${name}`;
  return [
    `Collection changes since ${ref}:`,
    ...changes.map(({ collection, status, cards }) => {
      const shown = cards.slice(0, DIFF_CARDS_SHOWN).map(signed).join(', ');
      const more = cards.length > DIFF_CARDS_SHOWN ? `, and ${cards.length - DIFF_CARDS_SHOWN} more` : '';
      return indent(`${collection}${status === 'changed' ? '' : ` (${status})`}: ${shown}${more}`);
    }),
    ...(decks.length
      ? ['Decks naming changed cards:', ...decks.map(({ deck, cards }) => indent(`${deck}: ${cards.join(', ')}`))]
      : ['No deck names a changed card.']),
  ];
}

// collection:commanders: each listed commander with its ownership, how the collection feeds its
// themes against an average collection, and EDHREC's view when a page is cached.
const lift = (value) => (value === null ? '?x' : `${value.toFixed(1)}x`);
const TOP_OWNED_SHOWN = 5;

function ownershipNote({ available, protectedIn, leads }) {
  const copies = available ? `${available} owned` : 'unowned';
  const protectedNote = protectedIn.length ? ` (+${holdingsNote(protectedIn)}, protected)` : '';
  const leadsNote = leads.length ? `; leads ${leads.join(', ')}` : '';
  return `${copies}${protectedNote}${leadsNote}`;
}

function edhrecLine(fit) {
  if (!fit) return [];
  if (fit.missing) return [`    EDHREC: no page (checked ${dateOf(fit.fetchedAt)})`];
  const top = fit.topOwned.slice(0, TOP_OWNED_SHOWN).map(({ name }) => name);
  const shares = [fit.synergyShare, fit.deckShare].map((value) => (value === null ? '?' : percent(value)));
  return [
    `    EDHREC: ${fit.owned} of ${fit.listed} listed cards owned, ${shares[0]} of its synergy and ${shares[1]} of an average deck (${fit.decks} decks, fetched ${dateOf(fit.fetchedAt)})`,
    ...(top.length ? [`      most synergy owned: ${top.join(', ')}`] : []),
  ];
}

export function commanderLines(
  results,
  { limit, withOracleText = false, sort, minCards, belowMinimum, unthemed, considered, themeFiltered = false },
) {
  const shown = results.slice(0, limit);
  const lines = shown.flatMap((result, position) => {
    const { card, themes } = result;
    const themeNotes = themes.map(({ name, cards, lift: themeLift }) => `${name} ${cards} (${lift(themeLift)})`);
    return [
      `${position + 1}. ${card.name} ${card.manaCost} [${identityLabel(card)}]${gameChangerNote(card)} — ${ownershipNote(result)} (${valueNote(result)})`,
      `    ${result.cards} on-theme cards of ${result.pool} owned spells, ${lift(result.lift)} an average collection (${Math.round(result.expected)} expected): ${themeNotes.join(', ')}`,
      ...edhrecLine(result.edhrec),
      ...(withOracleText ? oracleLines(card) : []),
    ];
  });
  const unthemedNote = `${unthemed} have no theme these tests recognise${themeFiltered ? ' or none matching --theme' : ''}`;
  return [
    ...lines,
    `${shown.length} of ${results.length} commanders shown, by ${sort}, of ${considered} the filters keep; ${belowMinimum} more have fewer than ${minCards} on-theme cards, and ${unthemedNote}`,
  ];
}
