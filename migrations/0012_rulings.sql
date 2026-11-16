-- Scryfall's rulings (its Rulings bulk file: Wizards' release notes and Scryfall's own notes), loaded
-- nightly by scripts/ingest-scryfall.mjs with the cards. One row per card that has any; rulings is a JSON
-- array of { date, source, text } in Scryfall's order. The hash lets the ingest write only what changed.
CREATE TABLE rulings (
  oracle_id TEXT PRIMARY KEY,
  rulings TEXT NOT NULL,
  hash TEXT NOT NULL
);
