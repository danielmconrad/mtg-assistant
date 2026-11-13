// mtg-manager's new-deck skill, with its commands as this server's tools.
import { DECK_SAVING } from './shared.mjs';

export const NEW_DECK = {
  name: 'new-deck',
  title: 'Brew a new deck',
  description:
    'Brew a Commander, Custom Dollar Brawl or casual-60 deck from the collection, from the brief through the plan, the list and the hand-off.',
  text: `# Brewing a new deck

Only unprotected binders supply cards, protected copies are only mentioned, and card data comes from the tools, never memory. This playbook is the order of work, and it hands parts of the job to others:

- collection-survey: step 2, finding the directions the collection supports.
- commander-scout: step 2 instead, when the person is open to buying a commander the collection supports.
- deckbuilding-strategy: the frameworks behind the plan, role counts, land count and bracket.
- deck-review: step 6, the check-and-fix loop.
- deck-upgrades: step 8, purchases.

${DECK_SAVING}

## 0. Preflight

- Existing decks: list_decks, and show_deck for their commanders. Don't propose a commander that already has a deck unless the person wants a second build.
- Card data: collection_summary's first line says how fresh the card data is.
- Continuing a draft: show_deck with oracle: true, deck_stats and check_deck, then resume at the step its state implies.

## 1. Settle the brief

Ask only about what the person hasn't said. A standing answer from earlier in the conversation or from memory counts: state it in one line instead of asking.

- Format: Commander, Custom Dollar Brawl (a house format: exactly 60 cards, Commander-legal, none over $1) or casual-60.
- Commander or theme: a named one, "open to anything from my collection", or "a commander I'd buy". The last goes to commander-scout in step 2; ask what the commander may cost if the budget doesn't say.
- Power level: a Commander Bracket (1–5) or the playgroup's own terms; the table is in deckbuilding-strategy. It becomes the deck's target bracket, which changes only when the person asks.
- Table: a four-player pod or 1v1. It changes what "whenever an opponent" triggers, symmetrical effects and wipes are worth.
- Play style: what the deck should feel like to play, and what to avoid (combos, stax, extra turns, long turns).
- Must-includes and no-gos: pet cards to build around, and cards or strategies the playgroup dislikes.
- Budget: amount and currency for optional upgrades, and any per-card price cap.
- Proxies: allowed or not.
- Binders: which binders to build from (collection_source), if not every unprotected one.
- Basics: search_cards with type: ["basic"], count: true. The collection holds few basics, so ask whether the person has untracked ones.

## 2. Survey, propose directions, then stop

Follow the collection-survey playbook: it sizes each candidate by role and engine depth and proposes two or three directions. When the person is open to buying the commander, follow commander-scout instead. Then wait for the person to choose. Don't run create_deck or write a list before they pick.

An unowned commander goes in the commanders like any other. Until it's in a binder, check_deck reports it as unavailable. Build and review the rest of the deck as usual, and note the purchase (the commander and its price) in the deck's notes.

## 3. Plan before choosing cards

Create the deck with create_deck: slug, commanders (two for partners), format, target_bracket, budget, max_card_price, allow_proxies, unlimited_basics, collection_source and a primer, from the brief. A slug is lowercase words joined by hyphens.

- Primer: how the deck wins, in one or two sentences (deckbuilding-strategy section 1).
- Engine map, in notes (update_deck set notes): what the commander and key engine cards use up and produce (life-gain events, Food, Treasure, any token, counters, spells cast, cards drawn), and which owned cards turn one into another (section 1a).
- role_targets: Commander decks are compared with the Command Zone template by default. Set targets when the plan departs from it (say, two wipes in a go-wide deck), and always for Custom Dollar Brawl and casual-60 (sections 3 and 5).
- power_notes: the bracket's limits that no tool checks (two-card combos, chained extra turns), and how the deck stays inside them.

## 4. Build a shortlist

Choose from a shortlist, never from one read of the whole pool: a 500-line dump can't be held in mind, and cards whose value is one step removed get lost.

- Search each role and each engine resource, both makers and payoffs. With commander: C and nonland: true: role: ["ramp"] with oracle: true (also draw, removal, wipe, protection); text: ["create .*(treasure|food|clue)"]; text: ["whenever an opponent|each player|target players?"].
- The role tests are rough (draw also matches cards that make an opponent draw, removal includes counterspells). Read the cards before counting them. For Custom Dollar Brawl add max_price: 1; for casual-60 use identity with min_copies: 4 for playsets.
- Read every match's full rules text, including activated abilities and who each effect targets. A symmetrical effect aimed at yourself is often an engine.
- Keep the shortlist grouped by role and engine resource, each card with a one-line reason.

## 5. Assemble the deck

In this order:

1. Nonland cards to the role targets, from the shortlist, with update_deck add operations: the plan's enablers and payoffs first, then the role cards. Give each entry a role (land, ramp, draw, removal, wipe, protection, wincon, synergy; comma-separate several).
2. Check the shape: deck_stats for the curve, role counts against targets, and color pips.
3. Mana base: take the land count from Karsten's suggestion (deckbuilding-strategy section 4) and explain any gap of more than a land. Choose utility and dual lands with search_cards (commander: C, type: ["land"], oracle: true). Count the lands that enter tapped, give each color sources in proportion to its pips, then fill with basics.
4. Size: exactly 100 cards including commanders (60 for Custom Dollar Brawl), or at least 60 for casual.
5. Considered: record the close calls with a one-line reason as you go (update_deck consider).

Commanders go in commanders, not the mainboard. Run check_deck after each round of edits.

## 6. Review until it passes

Follow the deck-review playbook: check, read the list, cover the left-out cards, compare with the frameworks, fix, and repeat until verify_deck passes.

## 7. Explain and hand off

Explain the deck: the game plan, the mana base (point to deck_stats), key inclusions, hard cuts, known weaknesses, and which bracket it plays like against its target.

The deck is done when:

- verify_deck passes. It fails on any check_deck error, a placeholder primer, a top-20 left-out card without a considered reason, upgrades over budget, or a plays_like_bracket not judged for this list. Explain every NOTE it prints (land gaps, role counts outside their targets).
- plays_like_bracket is judged for the final list (update_deck set), with the reasons in power_notes. Any change to the card list removes it, so judge it last (deckbuilding-strategy section 2).
- The summary names what's still unknown: unknown prices, and checks no tool makes.
- An unowned commander: verify_deck can't pass until it's bought. Hand the deck off as a draft whose only ERROR is the commander's ownership, say what it costs, and verify again once a binder holds it.

If the person wants to paste a saved deck into a site, export_deck gives a paste-ready list (upgrades: apply for a playtest list with every upgrade made).

## 8. Upgrades (optional)

Follow the deck-upgrades playbook.`,
};
