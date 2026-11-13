// mtg-manager's deck-review skill, with its commands as this server's tools.
import { DECK_SAVING } from './shared.mjs';

export const DECK_REVIEW = {
  name: 'deck-review',
  title: 'Review a deck',
  description:
    'Review, tune or finish a deck: check it, read its cards, cover the strong cards it leaves out, and compare roles and mana with the frameworks.',
  text: `# Reviewing a deck

The frameworks behind each judgment are in the deckbuilding-strategy playbook; this one is how to apply them with the tools. Base claims on tool output and card text from the tools, never memory, and say when data is missing.

${DECK_SAVING}

## The loop

Repeat until verify_deck passes and every NOTE it prints is explained:

1. Verify: verify_deck with the deck's slug (list_decks gives slugs). It runs check_deck and adds the hand-off checks: primer, stats, the top 20 left-out cards, upgrades against budget, and brackets. Fix every ERROR. Resolve or explain every INCOMPLETE. A NOTE (lands more than one from Karsten's suggestion, a role outside its target) needs a reason, recorded in power_notes and given to the person, not necessarily a fix.

2. Read the list itself: show_deck with oracle: true, and with role (e.g. removal) to read one role at a time. Check that each card does the job its role claims, and that every ability and target works the way the plan assumes. get_cards reads any single card, owned or not, with the decks that use it.

3. Measure: deck_stats — curve, color pips against land sources, role counts against targets, Karsten's land suggestion, opening-hand odds.

4. Cover the left-out cards: deck_candidates with oracle: true (the top 20 by EDHREC rank, then price); then once with role for each weak role, once with text for each engine resource in the notes, and with lands: true, type: ["land"] for the lands. Every listed card gets a place in the deck or a considered reason (update_deck consider); the summary line counts the shown ones without a reason. Rank and price only flag a card for a second look: they say it's popular or scarce, not that it fits. A strong left-out card means a weak inclusion should go.

5. Run the checklist in deckbuilding-strategy section 6: plan, bracket, roles, mana, win conditions, resilience, cuts. Judge plays_like_bracket whenever it's missing (any change to the card list removes it), record it with update_deck set, and put the reasons in power_notes. For the bracket, read the list and the upgrade adds for two-card combos and chained extra turns, which no tool detects. check_deck compares the bracket the cards set (Game Changers, extra turns, mass land denial) with the target, and covers color identity, legality and copy limits, upgrades included.

6. Make the changes (next section), then go back to step 1.

## Changes

- Draft decks: update_deck with a swap operation (out, in, reason). The reason becomes the out card's considered reason and the notes of a new history entry, and the in card takes the out card's role. Use add and remove for anything that isn't one-for-one; give remove a reason so the card doesn't come back unexplained in deck_candidates.
- Built decks (whose cards sit in their own collection) keep their card list: change it only when the person has swapped the physical cards, with swap_deck (out, in, reasons, and to for where the out cards go back).
- Records: reviews go in history (add_history); actual games in playtests (add_playtest). A few games don't make statistics.
- Ask before big rewrites; small agreed swaps can just be made.

## Reporting

Tell the person what changed and why, what check_deck still notes and the reasons, the weakest role, and what no tool could check. Point to deck_stats when talking about curve or color sources.`,
};
