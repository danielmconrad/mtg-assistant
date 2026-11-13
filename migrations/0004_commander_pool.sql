-- What every Commander-legal card adds to the pool commander ranking compares a collection against
-- (src/core/commanders.mjs poolProfile), precomputed by the ingest so a request needn't load every card.
-- The creature-type list the tribes were found with is in card_data_meta (creature_types).

CREATE TABLE commander_pool (
  oracle_id TEXT PRIMARY KEY,
  identity INTEGER NOT NULL, -- WUBRG as bits 1 to 16, as on cards
  themes INTEGER NOT NULL, -- a bit per THEMES entry the card feeds
  tribes TEXT NOT NULL, -- JSON array of creature types it has, makes or names ('*' for changelings)
  is_land INTEGER NOT NULL,
  can_command INTEGER NOT NULL, -- canBeCommander: a candidate for ranking
  hash TEXT NOT NULL
);

CREATE INDEX commander_pool_candidates ON commander_pool (can_command, identity);
