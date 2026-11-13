// mtg-manager's deck-upgrades skill, with its commands as this server's tools.
import { DECK_SAVING } from './shared.mjs';

export const DECK_UPGRADES = {
  name: 'deck-upgrades',
  title: 'Upgrade a deck',
  description:
    'Suggest and price purchases for a deck as paired swaps that keep it inside its budget, bracket and color identity.',
  text: `# Upgrading a deck

Upgrades are suggestions: paired swaps (a card to add, a card to cut, and why) kept in the deck's upgrades, and never made to the baseline without approval. A card the person approved but hasn't bought is still unowned.

${DECK_SAVING}

## 1. Before suggesting anything

- Budget: the deck needs one (amount and currency; update_deck set budget). Ask if it's missing.
- Baseline: the deck should pass verify_deck first (see the deck-review playbook), so each upgrade replaces a known weak card.

## 2. Find candidates from data, not memory

Search every card for ones the person has no available copy of, for the deck's commander C:

- search_cards with commander: C, scope: unowned, nonland: true, role: ["removal"], sort: edhrec, max_price: 5, oracle: true.
- search_cards with commander: C, scope: unowned, text: ["whenever you gain life"], sort: edhrec, oracle: true.

- Protected copies: results note copies the person owns in protected binders ("+1 in ..., protected"). Mention them, since moving a copy may be cheaper than buying one.
- Never cite card text, legality or prices from memory. get_cards gives one card's text, legality, price and the decks already using it.

## 3. Pair each add with a cut

- The cut: the weakest card in the same role, or the one the add makes redundant.
- The reason: name both cards and what the deck gains.
- The order: most impact first, so buying from the top down makes sense if the budget runs short.

## 4. Keep the upgraded deck legal

- Checks: check_deck judges a saved deck's upgrades too. It fails adds that raise the bracket above the target (Game Changers, extra turns, mass land denial), adds outside the color identity, cards not legal in the format, and second copies in a singleton deck.
- What no tool sees: read the adds for two-card combos (Heliod, Sun-Crowned with Walking Ballista, for instance) and chained extra turns, against the target bracket. Say which bracket the upgraded deck would play like, and warn about or drop an add that takes it above the target.

## 5. Record and price

1. Record each pair with update_deck add_upgrade (add, cut, reason; add_quantity and cut_quantity default to 1), most impact first.
2. deck_upgrades: report the total against the budget. Unknown prices stay unknown, never zero.
3. check_deck, which judges the upgraded list too.
4. Describe the upgraded deck from the tools: deck_stats with upgrades_applied: true, and show_deck with upgrades: apply and oracle: true. export_deck with upgrades: split lists the cuts and adds in their own sections, for buying.

## 6. After the person buys cards

Once the person says they have the cards, add them with add_cards (to the binder they name), then make each swap with update_deck: remove_upgrade for its add, then swap (out: the cut, in: the add, reason) in the same call. For a built deck, remove the upgrade with update_deck and swap with swap_deck once the person has swapped the physical cards.`,
};
