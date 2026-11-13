// Judging the bracket a deck plays like, without a full review. Its criteria are deckbuilding-strategy
// section 2; deck-review judges it the same way as one step of the loop.
export const BRACKET_CHECK = {
  name: 'bracket-check',
  title: 'Judge a deck’s bracket',
  description:
    'Judge which Commander Bracket a saved deck or a ManaBox deck binder plays like, record it as plays_like_bracket, and explain the call against its target.',
  text: `# Judging a deck's bracket

The bracket table and the three brackets a deck carries (target, lowest legal, plays-like) are in the deckbuilding-strategy playbook, section 2; read it first. Judge from the deck's real list and card text from the tools, never memory. This changes nothing but the deck's plays_like_bracket and power_notes.

## 1. Find the deck

- A saved deck: list_decks gives its slug.
- A deck binder with no saved deck (collection_summary marks deck binders, such as ManaBox decks): import_deck with binder saves it as a built deck whose cards are that binder. Without commanders, it takes the binder's only card that can be a commander, and otherwise lists the candidates; ask the person which is the commander rather than guessing. Pass target_bracket if the person says what the playgroup expects.

## 2. Read what the tools know

- check_deck: the lowest legal bracket the cards set (Game Changers, extra turns, mass land denial) and whether that's above the target.
- show_deck with oracle: true: the whole list with rules text. Read it all; the call rests on it.
- deck_stats: the curve, ramp and interaction counts, and opening-hand odds.
- get_cards for any card whose interactions need a closer look.

## 3. Judge

Work through the plays-like criteria, citing cards for each:

- Speed: the turn the deck can usually win or lock the game, against the table's "games last about" column.
- Fast mana and tutors: how often the deck finds its best cards early.
- Engine: how consistently the commander and its pieces come together.
- Combos: two-card combos (and when they can assemble: none before turn 6 in bracket 3), near-combos one tutor away, and chained extra turns. No tool detects these.
- Interaction and resilience: cheap removal, counterspells, protection, and recovery from a wipe.

Then pick one bracket. A deck whose cards allow a higher bracket can still play below it from a thin pool or a slow plan; tight synergy and cheap interaction push it above.

## 4. Record and report

Record the call with update_deck: set plays_like_bracket, and set power_notes to the reasons (the speed, the combos found or ruled out, what holds it at or pushes it past the bracket). Built decks accept this, since it doesn't change their cards. Any later change to the card list removes plays_like_bracket, so it's judged again.

Tell the person the bracket, the evidence for it, how it compares with the target and the lowest legal bracket, and which cards would move it up or down. If it plays above the target, name the cards to cut; don't change the list without asking.`,
};
