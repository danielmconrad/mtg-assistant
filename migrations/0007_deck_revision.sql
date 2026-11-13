-- A physical-deck move changes a deck and several collections in one batch; like collections.revision,
-- this lets the batch apply only if the deck is still as it was read (src/storage/collection-writes.mjs).
ALTER TABLE decks ADD COLUMN revision TEXT;
