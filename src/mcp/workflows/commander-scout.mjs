// mtg-manager's commander-scout skill, with its commands as this server's tools.
export const COMMANDER_SCOUT = {
  name: 'commander-scout',
  title: 'Scout commanders',
  description:
    'Find commanders, especially ones the person does not own yet, whose themes their collection already feeds, and propose two or three to buy and build.',
  text: `# Scouting commanders

Only unprotected binders supply cards, protected copies are only mentioned, and card text, prices and legality come from the tools, never memory. The collection-survey playbook sizes commanders the person already owns; this one searches every Commander-legal commander, owned or not, and ranks them by how much of the collection feeds them.

## 0. Preflight

- The brief: format, budget for the commander and upgrades, and any colors, themes or commanders the person wants or wants to avoid. Ask only about what's missing; the new-deck playbook's step 1 lists the rest.
- Card data: collection_summary's first line says how fresh it is. Every Scryfall card is loaded nightly, so unowned commanders are always there.
- Existing decks: each result says which decks the commander already leads ("leads ..."). Skip those unless the person wants a second build. A built deck's cards sit in its own protected list, so they don't count toward any other commander.

## 1. Rank every commander

- rank_commanders with ownership: unowned — the best unowned commanders, by lift.
- rank_commanders with ownership: unowned, sort: cards — the deepest on-theme pools.
- rank_commanders with ownership: unowned, identity: BG, limit: 10 — within some colors (subsets included).
- rank_commanders with ownership: unowned, theme: "food|Halfling" — one theme or creature type.
- rank_commanders with ownership: unowned, max_price: 5, oracle: true — cheap commanders, with their rules text.

For each commander's rules text, the tool finds the themes it cares about (tokens, Food, +1/+1 counters, spells and so on) and the creature types it names, then counts the available nonland cards in its color identity that feed them. Reading a result:

- On-theme cards: owned cards that feed at least one theme. That's the pool's depth, and 30 (min_cards, the default floor) is about a third of a Commander deck's spells.
- Lift: on-theme cards divided by how many an average collection this size would hold in those colors. Lift is what makes a commander right for this collection: 4x Dwarves means the person is unusually deep in Dwarves. Broad themes often sit around 1.5x, because collections lean toward recent, Commander-friendly cards, so look for 2x and up.
- Per theme: each theme's own count and lift. A high lift only matters on the theme that is the commander's plan. A commander whose text mentions Treasure once still "cares" about Treasure here.
- Pool: owned spells in the identity. Five-color commanders get the biggest pools, so lift, not size, is the default sort, and the mana base needs checking separately.
- Value: EDHREC rank (popularity) and the cheapest price.

The tests are rough rules-text patterns. Tribe counts include cards that only name the type, and themes overlap. They find leads; they don't judge fit. Run a few sorts and filters, then shortlist 10 to 20 commanders whose main theme carries the lift.

Check the shortlist against EDHREC, whose commander pages list the cards real decks play with each commander. refresh_edhrec fetches up to 10 pages a call, one a second, either named (commanders: [...]) or the top of the same ranking (top: 10 with the same filters). Pages are shared and kept 30 days (max_age_days, force). Then rank_commanders with sort: edhrec shows, for each commander with a page:
- Listed cards owned: how many of the cards on its page are available.
- Share of its synergy: the owned share of EDHREC's positive synergy (how much more often a card is played with this commander than with others of its colors). The best single measure of owning its signature cards.
- Share of an average deck: weighted by how often decks play each card, so staples count. A high deck share with a low synergy share means a generic pile of good cards.
- Most synergy owned: the owned cards EDHREC ties most closely to it. Read them; they're the engine already owned.

When lift and EDHREC disagree, find out why. High lift with low synergy share means the theme tests matched cards those decks don't play; low lift with high synergy share means a plan the tests don't recognize. A page built from fewer than about 100 decks is thin evidence. EDHREC's JSON is undocumented: if refresh_edhrec stops on the response's shape, say so rather than guessing, and never quote EDHREC numbers from memory.

## 2. Read the best few

For the four or five strongest, size the pool as the collection-survey playbook's step 2 does (role counts, tribes, lands), then read the engine, for commander C:

- get_cards with names: [C] — rules text, price, legality, protected copies.
- search_cards with commander: C, nonland: true, group_by: role.
- search_cards with commander: C, nonland: true, text: ["REGEX FOR ITS THEME"], sort: edhrec, oracle: true.
- search_cards with commander: C, scope: unowned, text: ["REGEX FOR ITS THEME"], sort: edhrec, max_price: 2 — cheap missing pieces.

Then judge:

- The plan: does the commander use what the on-theme cards produce? Map it as in the deckbuilding-strategy playbook's section 1a.
- Gaps: weak roles, and well-played cards in its theme the person lacks (read each with get_cards before naming it).
- Format: for Custom Dollar Brawl, add max_price: 1 to the searches. rank_commanders counts every owned card whatever its price, so check the cards a deck could actually play.
- Protected copies: a commander owned only in a precon shows as unowned with "(+1 in ..., protected)". Moving that copy is the person's call.

## 3. Propose two or three, then stop

For each:

- Commander and price: its cheapest price, or a protected copy to move.
- Plan: the game plan in two sentences, and how it wins.
- Evidence: on-theme cards and lift for its main theme, e.g. "39 Villains, 6x an average collection".
- Key owned cards: the engine pieces from steps 1 and 2.
- Gaps and extra purchases: weak roles, and cheap missing pieces with prices from get_cards.
- Overlap: decks already using the same cards. Drafts don't reserve cards, but the person should know.

Then wait for the person to choose. Don't buy anything or run create_deck until they pick; if they want to build it, continue with the new-deck playbook's step 3. An unowned commander stays unowned until it's in a binder, and check_deck reports it until then.`,
};
