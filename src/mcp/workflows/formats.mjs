// mtg-manager's deckbuilding-strategy formats reference.
export const FORMATS = {
  name: 'formats',
  title: 'Magic formats',
  description:
    "Moxfield's formats with their deck sizes, card pools and Scryfall legality keys, and the three formats saved decks support.",
  text: `# Magic formats (Moxfield's list)

These are the formats in Moxfield's deck-format dropdown, as of October 2026, with the deckbuilding rules that matter here. Use the names when talking to the user or when they set a deck's format on Moxfield. Ban lists and points lists change often, so check the linked source or get_cards before relying on one. Saved decks support only three formats (see Deck formats).

Where a **Scryfall key** is given, every card has that legality (legal, not_legal, restricted or banned), so card legality comes from get_cards and search_cards' legal filter, not memory. Formats without a key are fan formats Scryfall doesn't track. Moxfield checks some of them, but this server can't.

## Deck formats

| A deck's format | Rules | Closest Moxfield format |
| --- | --- | --- |
| commander | Exactly 100 with commanders, singleton | Commander / EDH |
| custom-dollar-brawl | House format: exactly 60 with commanders, singleton, Commander legality, no card over 1 USD (cheapest printing; a deck's price cap overrides) | None. Commander's rules at 60 cards; Moxfield's Brawl formats use different card pools. |
| casual-60 | At least 60, up to 4 copies, no sanctioned rules | None (Moxfield's "None") |

## Commander-style formats

All use a commander in the command zone and singleton decks (one copy of each card except basic lands), and the deck's colors must match the commander's color identity unless noted.

| Moxfield name | Scryfall key | Deck | Life | Card pool and rules |
| --- | --- | --- | --- | --- |
| Commander / EDH | commander | 100 with commander | 40 | All cards except the Commander ban list. Multiplayer. 21 commander damage. Commander Brackets set power level. |
| Brawl | brawl | 100 with commander | 25 (1v1) | MTG Arena's card pool (Historic Brawl until December 2023). Planeswalkers can be commanders. No commander damage. |
| Standard Brawl | standardbrawl | 60 with commander | 25 (1v1) | Standard-legal cards only, so it rotates. Planeswalkers can be commanders. No commander damage. Called just "Brawl" before 2023. |
| Competitive Brawl | competitivebrawl | 100 with commander | — | Arena Brawl with a community ban list for competitive play. Details not verified. |
| Duel Commander | duel | 100 with commander | 20 | 1v1 with its own ban list and banned-as-commander list (duelcommander.org (https://www.duelcommander.org/)). No commander damage. |
| Russian Duel Commander | — | — | — | A Russian community's variant of Duel Commander with its own ban list. Rules not verified. |
| Pauper EDH | paupercommander | 100 with commander | — | Commander is an uncommon creature. The other 99 cards are commons. |
| PreDH | predh | 100 with commander | 40 | Commander using only cards printed before the first Commander products (2011), for an old-school feel. |
| Oathbreaker | oathbreaker | 60 with oathbreaker and spell | 20 | The commander is a planeswalker (the oathbreaker) plus an instant or sorcery signature spell, cast only while the oathbreaker is on the battlefield. |
| Tiny Leaders | — | 50 with commander | 20 (Reborn); 25 before | Every card, commander included, has mana value 3 or less. Mostly 1v1. No commander damage. |
| Archon | — | At least 100 | 20 | 1v1 Commander run by a community council (archon.page (https://archon.page/rules/)). No commander damage. |
| Centurion | — | 100 with commander | 25 | Commander variant with a ban list aimed at fast mana (Sol Ring, Mana Crypt and the like), updated every two months. |
| Conquest | — | At least 80 with commander | 30 (25 in 1v1) | Made by the cEDH creator Shaper to narrow the casual/competitive gap. Planeswalkers can be commanders. 12 commander damage. Bans one-mana tutors, fetch lands and top mana rocks. |
| Pendragon | — | 100 | 30 | Fan format whose commander is a common creature paired with a legendary Equipment (the "Excalibur"). 21 commander damage. Played 1v1 or 4v4. |

## Constructed formats

60-card minimum, up to four copies of each card, and a 15-card sideboard unless noted.

| Moxfield name | Scryfall key | Card pool and rules |
| --- | --- | --- |
| Standard | standard | Recent sets only, rotating yearly. |
| Pioneer | pioneer | Return to Ravnica (2012) onward, non-rotating. |
| Modern | modern | Eighth Edition (2003) onward, non-rotating. |
| Legacy | legacy | All cards, with a ban list. |
| Vintage | vintage | All cards, with a short ban list and a restricted list (one copy each). |
| Pauper | pauper | Cards printed at common. |
| Premodern | premodern | Fourth Edition through Scourge (1995–2003). |
| Old School | oldschool | The earliest sets (1993–94). |
| Penny Dreadful | penny | Magic Online cards costing 0.02 tickets or less, refreshed each season. |
| Value Vintage | — | Vintage ban and restricted lists, but the whole deck and sideboard must cost under $30, basics excluded. |
| Alchemy | alchemy | MTG Arena only: Standard plus Arena-only digital cards and rebalanced versions. |
| Historic | historic | MTG Arena's non-rotating format. |
| Timeless | timeless | MTG Arena's whole card pool, with a restricted list. |

## Singleton (Highlander) formats

No commander. Singleton except basic lands.

| Moxfield name | Scryfall key | Deck | Life | Rules |
| --- | --- | --- | --- | --- |
| Canadian Highlander | — | 100 | 20 | Vintage card pool, 1v1. A points list (10 points per deck, e.g. Black Lotus 7) instead of most bans (canadianhighlander.ca (https://canadianhighlander.ca/)). |
| Australian Highlander | — | 60 | 20 | Vintage ban list plus a 7-point points list. |
| European Highlander | — | 100 | 20 | Vintage-based, best of three, no sideboard. A council ban list instead of points, updated quarterly (highlandermagic.info (https://highlandermagic.info/rules/)). |
| Gladiator | gladiator | 100 | 20 | MTG Arena's Timeless card pool, best of three, no sideboard or companions, with its own ban list. |
| Highlander Gauntlet | — | — | — | A wheel of six singleton decks played against each other, first sanctioned in 2019. Rules not verified. |

## Limited-style and other formats

| Moxfield name | Rules |
| --- | --- |
| Alpha 40 | 40-card decks from the original Alpha set only, at most three copies of a rare, to recreate playing from a few 1993 starter decks. |
| Primordial | 40-card decks from a single set. Commons and basics unlimited; at most 6 uncommons (2 copies each) and 2 rares (1 copy each). |
| Dandan | Two players share one 80-card all-blue library and graveyard (10 Dandân, 8 Memory Lapse, mostly two-ofs, unlimited Islands). 20 life. |
| None | No format checks. |

## Sources

mtg.wiki (https://mtg.wiki/page/Brawl) (Brawl, Standard Brawl, Highlander, Archon, Tiny Leaders, Centurion), Draftsim (https://draftsim.com/) (Conquest, Gladiator, Value Vintage, Dandân, Standard Brawl), Duel Commander (https://www.duelcommander.org/rules/quickrules/), European Highlander (https://highlandermagic.info/rules/), Canadian Highlander (https://magic.wizards.com/en/news/feature/introduction-canadian-highlander-2016-05-17), Archon (https://archon.page/rules/), Pendragon (https://sites.google.com/view/pendragonmtg/basic-rules-guidelines), Alpha 40 (https://fabiensanglard.net/mtg/a40/), Primordial (mtgrocks) (https://mtgrocks.com/primordial-mtg/). Moxfield itself blocks automated requests, so its own format pages weren't read. Scryfall keys come from the card data's legality fields; the sanctioned formats' summaries are their well-known rules.`,
};
