-- Card Kingdom's retail prices, loaded nightly by scripts/ingest-scryfall.mjs from Card Kingdom's public
-- price list: each printing's cheapest nonfoil near-mint price (preferring copies in stock), and whether
-- any copy is in stock (1 or 0), both null when Card Kingdom doesn't list the printing. Stock is kept as
-- yes or no rather than a count, so a nightly change in Card Kingdom's counts doesn't rewrite the row.
ALTER TABLE prices ADD COLUMN ck_usd REAL;
ALTER TABLE prices ADD COLUMN ck_in_stock INTEGER;
