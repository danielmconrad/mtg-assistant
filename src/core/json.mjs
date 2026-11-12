// Turns reports into the data the CLI prints with --json, as format.mjs does for text. Field names are
// snake_case to match the deck YAML that assistants read and write. Nothing here decides an outcome.
import { orderedIdentity } from './card.mjs';
import { CENTS_PER_UNIT } from './upgrades.mjs';

const fromCents = (cents) => cents / CENTS_PER_UNIT;
const fromMap = (counts) => Object.fromEntries(counts);

export const cardJson = (card) => ({
  name: card.name,
  mana_cost: card.manaCost,
  mana_value: card.manaValue,
  type_line: card.typeLine,
  color_identity: orderedIdentity(card),
  oracle_text: card.oracleText,
  game_changer: card.gameChanger,
});

// One collection:search or deck:candidates result: the card, its copies and its value signals.
export const searchResultJson = ({
  card,
  available,
  protected: protectedCopies,
  protectedIn,
  priceUsd,
  edhrecRank,
  printing,
}) => ({
  ...cardJson(card),
  printing: printing
    ? { set: printing.set, collector_number: printing.collectorNumber, rarity: printing.rarity ?? null }
    : null,
  available,
  protected: protectedCopies,
  protected_in: protectedIn.map(({ name, copies }) => ({ collection: name, copies })),
  price_usd: priceUsd,
  edhrec_rank: edhrecRank,
});

export const collectionJson = (name, path, isProtected, { rowCount, copies, distinctNames, proxyCopies }, rows) => ({
  name,
  path,
  protected: isProtected,
  rows: rowCount,
  copies,
  distinct_names: distinctNames,
  proxy_copies: proxyCopies,
  not_cached: rows.filter((row) => !row.scryfallId).map((row) => ({ location: row.location, name: row.name })),
});

export const checkJson = ({ total, findings, outcome }) => ({
  outcome,
  total_cards: total,
  findings: findings.map(({ level, message }) => ({ level, message })),
});

export const candidatesJson = (results, { limit, overCap = 0, unresolvedRows = 0 }) => {
  const shown = results.slice(0, limit);
  const unexplained = (list) => list.filter((result) => !result.considered).length;
  return {
    left_out: results.length,
    shown: shown.length,
    unexplained_shown: unexplained(shown),
    unexplained_total: unexplained(results),
    over_price_cap: overCap,
    unresolved_rows: unresolvedRows,
    cards: shown.map((result) => ({ ...searchResultJson(result), considered: result.considered ?? null })),
  };
};

export const statsJson = (stats) => ({
  mainboard_cards: stats.cards,
  lands: stats.lands,
  average_mana_value: stats.cards - stats.lands ? stats.averageManaValue : null,
  suggested_lands: stats.suggestedLands,
  cheap_ramp_and_draw: stats.cheapRampAndDraw,
  curve: fromMap(stats.curve),
  types: fromMap(stats.types),
  pips: fromMap(stats.pips),
  land_sources: fromMap(stats.landSources),
  roles: fromMap(stats.roles),
  brackets: stats.bracket && {
    lowest_legal: stats.bracket.bracket,
    plays_like: stats.bracket.playsLike,
    target: stats.bracket.target,
    raised_by: stats.bracket.raises.map(({ bracket, reason }) => ({ bracket, reason })),
  },
  role_targets: { source: stats.roleTargets.source, targets: stats.roleTargets.targets },
  opening_hand: stats.openingHand && {
    zero_or_one_land: stats.openingHand.fewLands,
    two_to_four_lands: stats.openingHand.keepableLands,
    five_or_more_lands: stats.openingHand.manyLands,
    some_ramp: stats.openingHand.someRamp,
  },
  problems: stats.problems,
});

export const upgradesJson = ({ currency, purchases, problems, unresolvedRows, totalCents, budgetCents }) => ({
  currency,
  budget: fromCents(budgetCents),
  total: fromCents(totalCents),
  purchases: purchases.map(({ card, quantity, unitCents, printing, problem }) =>
    problem
      ? { name: card.name, quantity, problem }
      : {
          name: card.name,
          quantity,
          unit_price: fromCents(unitCents),
          price: fromCents(quantity * unitCents),
          set: printing.set,
          collector_number: printing.collectorNumber,
        },
  ),
  problems,
  unresolved_rows: unresolvedRows,
});

// A copy deck:build, deck:teardown or deck:swap moves, with the printing and finish it carries.
export const copyJson = (quantity, card, finish = 'normal') => ({
  quantity,
  name: card.name,
  set: card.set,
  collector_number: card.collectorNumber,
  finish,
});

// deck:build's takes, by the collection file each comes from, plus untracked basics.
export const takesJson = (plan, takenFrom) => ({
  takes: [...takenFrom].flatMap(([path, takes]) =>
    takes.map(({ row, card, quantity }) => ({ from: path, ...copyJson(quantity, card, row.finish) })),
  ),
  untracked_basics: plan.untracked.map(({ card, quantity }) => ({ quantity, name: card.name })),
});

// deck:teardown's returns, by the text list each goes back to, plus untracked basics.
export const returnsJson = ({ returns, untracked }) => ({
  returns: [...returns].flatMap(([path, copies]) =>
    copies.map(({ card, finish, quantity }) => ({ to: path, ...copyJson(quantity, card, finish) })),
  ),
  untracked_basics: untracked.map(({ name, quantity }) => ({ quantity, name })),
});

const shownJson = ({ card, quantity, roles, upgrade }) => ({ ...cardJson(card), quantity, roles, upgrade });

export const showJson = ({ commanders, groups, problems }) => ({
  commanders: commanders.map(shownJson),
  mainboard: groups.flatMap(({ items }) => items.map(shownJson)),
  problems,
});

export const cardReportJson = (report) =>
  report.problem
    ? { name: report.name, problem: report.problem, suggestions: report.suggestions }
    : {
        ...cardJson(report.card),
        commander_legality: report.card.legalities.commander ?? null,
        price_usd: report.priceUsd,
        edhrec_rank: report.edhrecRank,
        printings_cached: report.printings,
        available: report.available,
        protected_in: report.protectedIn.map(({ name, copies }) => ({ collection: name, copies })),
        decks: report.uses.map(({ deck, as, roles, reason }) => ({
          deck,
          as,
          ...(roles && { roles }),
          ...(reason && { reason }),
        })),
      };

export const cacheStatusJson = ({ printings, cards, fromBulk, bulkBuiltAt, refreshedAt, daysSinceRefresh }) => ({
  printings,
  cards,
  from_bulk: fromBulk,
  bulk_built_at: bulkBuiltAt,
  refreshed_at: refreshedAt,
  days_since_refresh: daysSinceRefresh,
});

// A commander's EDHREC page as collection:commanders scores it.
const edhrecJson = (fit) =>
  fit.missing
    ? { missing: true, fetched_at: fit.fetchedAt }
    : {
        missing: false,
        fetched_at: fit.fetchedAt,
        decks: fit.decks,
        listed: fit.listed,
        owned: fit.owned,
        synergy_share: fit.synergyShare,
        deck_share: fit.deckShare,
        top_owned: fit.topOwned,
      };

// One collection:commanders result.
export const commanderJson = (result) => ({
  ...searchResultJson(result),
  leads: result.leads,
  owned_spells: result.pool,
  on_theme: result.cards,
  expected: result.expected,
  lift: result.lift,
  themes: result.themes.map(({ name, cards, expected, lift }) => ({ name, cards, expected, lift })),
  edhrec: result.edhrec && edhrecJson(result.edhrec),
});
