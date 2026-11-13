// mtg-manager's collection-survey skill, with its commands as this server's tools.
export const COLLECTION_SURVEY = {
  name: 'collection-survey',
  title: 'Survey the collection',
  description:
    'Find which commanders and themes the collection supports, sizing each by role and engine depth, and propose two or three directions.',
  text: `# Surveying the collection

Only unprotected binders supply cards; protected copies (precons, built decks) are only mentioned. Every tool here is read-only. This sizes commanders the person owns; for commanders they could buy, ranked by how much of the collection feeds them, follow the commander-scout playbook. Start with counts and groups, and list cards only once a query is narrow: unfiltered lists run to hundreds of lines.

## 1. Find commander candidates

- search_cards with commanders_only: true, legal: commander, group_by: identity. group_by identity counts exact identities (WR means only red-white cards), while the identity and commander filters include every subset (WR also matches mono-W, mono-R and colorless), which is what a deck can play.
- search_cards with commanders_only: true, legal: commander, identity: WR, sort: edhrec.
- get_cards with exact names reads any card, owned or not.

Skip commanders that already lead a deck (list_decks, then show_deck) unless the person wants a second build.

rank_commanders with ownership: owned ranks the owned commanders by how much of the collection feeds the themes their rules text names, against an average collection. It's a quick way to pick which candidates to size below; the commander-scout playbook explains its output.

## 2. Size each candidate

For each candidate C, and compare the results in a table:

- search_cards with commander: C, nonland: true, count: true — depth of the playable pool.
- search_cards with commander: C, nonland: true, group_by: role — ramp, draw, removal, wipe, protection, other.
- search_cards with commander: C, group_by: creature-type — tribes.
- search_cards with commander: C, type: ["land"], count: true — nonbasic lands for the mana base.

The role tests are rough: draw also counts cards that make an opponent draw, and removal includes counterspells, which matters mostly in blue. Before quoting a role count, read the list with role and oracle: true.

## 3. Sketch the engine

For the most promising candidates, search what the commander uses up and produces, not just its theme words (see "Map the engine" in the deckbuilding-strategy playbook). For example, with commander: C and nonland: true:

- text: ["create .*(treasure|food|clue|blood|map)"]
- text: ["whenever an opponent|each opponent|each player|target players?"], oracle: true
- text: ["for each (food|treasure|artifact|token|creature)"]

Add sort: edhrec or sort: price to see the most played or most valuable matches first.

## 4. Allow for the format

- Custom Dollar Brawl: add max_price: 1 to every search. Cards over the cap can't be played, even ones already owned.
- Casual-60: there's no commander. Search by identity, and use min_copies: 4 to find cards owned as playsets for the Rule of 9.
- Bracket: search_cards with game_changers: true and include_protected: true shows which Game Changers the person owns, and every list marks them [Game Changer].

## 5. Note protected staples

Name staples that exist only in protected collections, so the person can choose to move a copy: search_cards with include_protected: true and name: "^(Sol Ring|Arcane Signet|Command Tower|Swords to Plowshares|Path to Exile|Cultivate|Beast Within|Counterspell)$".

## 6. Propose two or three directions, then stop

For each direction give:

- Commander and plan: the commander, the game plan in two sentences, and how it wins.
- Key owned cards: the cards that make it work, with counts from the survey (e.g. "25 Dwarves, 36 ramp pieces").
- Mana: colors, how many sources it needs, and the lands and ramp available.
- Gaps: weak roles, and protected copies that would help.
- Upgrades: the rough upgrade need against the budget.

Then wait for the person to choose. Don't run draft_deck or write a list before they pick.`,
};
