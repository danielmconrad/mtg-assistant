-- Each person's collections and decks. Every row carries user_id, and every read filters on it.

-- A reserved account: created ahead of a first sign-in (scripts/migrate-from-mtg-manager.mjs), with a
-- placeholder google_sub. The first sign-in with its email claims it and pins the real Google ID.
ALTER TABLE users ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;

CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  -- Relative path without extension (binders/Alphabetized), as mtg-manager named collections.
  name TEXT NOT NULL,
  -- Relative path with extension, for matching a deck's collection_source patterns as mtg-manager did.
  path TEXT NOT NULL,
  format TEXT NOT NULL, -- manabox_csv or text
  protected INTEGER NOT NULL, -- reported, but never used by decks
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, name)
);

CREATE TABLE collection_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  -- The row's index in its source file, which mtg-manager's physical-deck moves rely on.
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  scryfall_id TEXT, -- null for a text row whose printing wasn't found
  set_code TEXT,
  collector_number TEXT,
  finish TEXT NOT NULL,
  is_proxy INTEGER NOT NULL,
  in_deck_binder INTEGER NOT NULL,
  -- A ManaBox row's other columns (condition, language, purchase price...), as JSON, for exports.
  source_record TEXT
);

CREATE INDEX collection_entries_collection ON collection_entries (user_id, collection_id, position);
CREATE INDEX collection_entries_card ON collection_entries (user_id, scryfall_id);

CREATE TABLE decks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  format TEXT NOT NULL,
  status TEXT NOT NULL,
  doc TEXT NOT NULL, -- the deck as JSON, valid against schemas/deck.schema.json
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, slug)
);
