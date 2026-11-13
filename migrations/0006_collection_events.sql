-- Changes to a person's collections made through the server (add_cards, remove_cards, and later uploads
-- and physical-deck moves), one row per card per change, so collection_changes can say what changed
-- since a date. Purchase prices are never recorded here.
CREATE TABLE collection_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  -- Every row a single change wrote shares its batch ID.
  batch_id TEXT NOT NULL,
  at TEXT NOT NULL,
  source TEXT NOT NULL, -- the tool or page that made the change
  collection_name TEXT NOT NULL,
  name TEXT NOT NULL,
  scryfall_id TEXT,
  finish TEXT,
  change INTEGER NOT NULL, -- copies added (positive) or removed (negative)
  note TEXT
);

CREATE INDEX collection_events_user_at ON collection_events (user_id, at);

-- Changes to a collection are applied only if it is still at the revision they were planned from, so
-- two changes at once can't both apply to the same starting point (src/storage/collection-writes.mjs).
ALTER TABLE collections ADD COLUMN revision TEXT;
