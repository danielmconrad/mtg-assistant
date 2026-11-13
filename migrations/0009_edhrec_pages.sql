-- EDHREC commander pages (src/core/edhrec.mjs's parsePage), fetched on demand by refresh_edhrec and kept
-- for 30 days. Public data shared by every person, so there's no user_id. cards is the page's card
-- listings as JSON; a commander EDHREC has no page for is stored with missing = 1.
CREATE TABLE edhrec_pages (
  name TEXT PRIMARY KEY, -- the commander's name in the card data
  slug TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  missing INTEGER NOT NULL,
  decks INTEGER,
  cards TEXT
);
