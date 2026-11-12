-- Every card on Scryfall, loaded nightly by scripts/ingest-scryfall.mjs. Rules fields live on cards (one
-- row per oracle ID); what differs between printings lives on printings; prices change daily, so they
-- have their own table and an unchanged card or printing is never rewritten. Each row's hash lets the
-- ingest write only what changed.

CREATE TABLE cards (
  oracle_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- normalizeName (src/core/card.mjs) of name and front_name, for exact lookups.
  name_key TEXT NOT NULL,
  front_name TEXT NOT NULL,
  front_name_key TEXT NOT NULL,
  mana_cost TEXT NOT NULL,
  mana_value REAL NOT NULL,
  type_line TEXT NOT NULL,
  front_type TEXT NOT NULL,
  oracle_text TEXT NOT NULL,
  keywords TEXT NOT NULL, -- JSON array
  -- Bitmask W=1 U=2 B=4 R=8 G=16, so "fits in identity M" is (color_identity & ~M) = 0.
  color_identity INTEGER NOT NULL,
  produced_mana TEXT NOT NULL, -- JSON array
  -- JSON object of the formats where the card isn't not_legal: legal, restricted or banned.
  legalities TEXT NOT NULL,
  legal_commander INTEGER NOT NULL, -- 1 when legal (or restricted) in Commander
  playable INTEGER NOT NULL, -- 1 when legal somewhere: real cards, not tokens or art cards
  game_changer INTEGER NOT NULL,
  edhrec_rank INTEGER,
  hash TEXT NOT NULL
);

CREATE INDEX cards_name_key ON cards (name_key);
CREATE INDEX cards_front_name_key ON cards (front_name_key);
CREATE INDEX cards_commander_identity ON cards (legal_commander, color_identity);
CREATE INDEX cards_edhrec_rank ON cards (edhrec_rank);

CREATE TABLE printings (
  id TEXT PRIMARY KEY, -- Scryfall ID
  oracle_id TEXT NOT NULL,
  name TEXT NOT NULL,
  set_code TEXT NOT NULL,
  collector_number TEXT NOT NULL,
  rarity TEXT,
  border_color TEXT,
  set_type TEXT,
  flavor_name TEXT,
  is_default INTEGER NOT NULL, -- Scryfall's default printing for the card's name
  -- Rules fields where this printing differs from its card (a reversible Secret Lair printing's name,
  -- for one), as a JSON object; null when it doesn't.
  overrides TEXT,
  -- Formats Scryfall judges per printing (Old School), as JSON; null when none apply.
  printing_legalities TEXT,
  hash TEXT NOT NULL
);

CREATE INDEX printings_set_number ON printings (set_code, collector_number);
CREATE INDEX printings_oracle_id ON printings (oracle_id);

CREATE TABLE prices (
  printing_id TEXT PRIMARY KEY,
  usd REAL,
  usd_foil REAL,
  usd_etched REAL,
  eur REAL,
  hash TEXT NOT NULL
);

-- Full-text search over rules text, for narrowing text searches before the regex runs. Its rowid is the
-- card's rowid (kept stable by upserting with ON CONFLICT ... DO UPDATE).
CREATE VIRTUAL TABLE cards_fts USING fts5(name, type_line, oracle_text, tokenize = 'unicode61');

-- What the last ingest loaded: bulk_built_at, ingested_at and row counts.
CREATE TABLE card_data_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
