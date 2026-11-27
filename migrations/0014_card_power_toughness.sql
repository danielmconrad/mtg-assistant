-- The front face's printed power and toughness, as Scryfall writes them ("6", "*", "1+*"), null for a card
-- without a power/toughness box. Commander eligibility needs them: a legendary Vehicle or Spacecraft with a
-- box can be a commander. Null until the next ingest fills them in.
ALTER TABLE cards ADD COLUMN power TEXT;
ALTER TABLE cards ADD COLUMN toughness TEXT;
