// mtg-manager's deck-review skill, with its commands as this server's tools.
import { NO_DECK_WRITES } from './shared.mjs';

export const DECK_REVIEW = {
  name: 'deck-review',
  title: 'Review a deck',
  description:
    'Review, tune or finish a deck: check it, read its cards, cover the strong cards it leaves out, and compare roles and mana with the frameworks.',
  text: `# Reviewing a deck

The frameworks behind each judgment are in the deckbuilding-strategy playbook; this one is how to apply them with the tools. Base claims on tool output and card text from the tools, never memory, and say when data is missing.

${NO_DECK_WRITES}

## The loop

Repeat until check_deck passes and every NOTE it prints is explained:

1. Check: check_deck with the deck's slug (list_decks gives slugs). Fix every ERROR. A NOTE (a role outside its target, a bracket the cards set) needs a reason, recorded in the power notes and given to the person, not necessarily a fix.

2. Read the list itself: show_deck with oracle: true, and with role (e.g. removal) to read one role at a time. Check that each card does the job its role claims, and that every ability and target works the way the plan assumes. get_cards reads any single card, owned or not, with the decks that use it.

3. Measure: deck_stats — curve, color pips against land sources, role counts against targets, Karsten's land suggestion, opening-hand odds.

4. Cover the strong cards left out. For the deck's commander C, search what it could play and doesn't: search_cards with commander: C, nonland: true, sort: edhrec, oracle: true; then once with role for each weak role, once with text for each engine resource in the notes, and with type: ["land"] for the lands. Every strong card the deck leaves out gets a place in the deck or a one-line considered reason. Rank and price only flag a card for a second look: they say it's popular or scarce, not that it fits. A strong left-out card means a weak inclusion should go.

5. Run the checklist in deckbuilding-strategy section 6: plan, bracket, roles, mana, win conditions, resilience, cuts. Judge which bracket the deck plays like whenever the list changed, and give the reasons. For the bracket, read the list and the upgrade adds for two-card combos and chained extra turns, which no tool detects. check_deck compares the bracket the cards set (Game Changers, extra turns, mass land denial) with the target, and covers color identity, legality and copy limits, upgrades included.

6. Propose the changes, each with its reason, then go back to step 1 once they're made.

## Changes

- Draft decks: a swap names the card out, the card in, and why the out card left (its considered reason).
- Built decks (whose cards sit in their own collection): propose swaps only when the person says they've swapped the physical cards.
- Records: reviews and swaps belong in the deck's history (date, changes, notes); actual games in its playtests. A few games don't make statistics.

## Reporting

Tell the person what to change and why, what check_deck still notes and the reasons, the weakest role, and what no tool could check. Point to deck_stats when talking about curve or color sources.`,
};
