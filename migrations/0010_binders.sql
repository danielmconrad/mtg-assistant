-- Each row of collections is now a binder: a named set of cards. A person's collection is every card in
-- their binders. kind says whether a binder is an ordinary one or a deck's: a built deck's own cards, or a
-- ManaBox deck. Deck binders are protected (reported, but never used by other decks).
ALTER TABLE collections ADD COLUMN kind TEXT NOT NULL DEFAULT 'binder' CHECK (kind IN ('binder', 'deck'));

-- A built deck's collection_destination is its deck binder.
UPDATE collections SET kind = 'deck', protected = 1
WHERE EXISTS (
  SELECT 1 FROM decks d
  WHERE d.user_id = collections.user_id AND json_extract(d.doc, '$.collection_destination') = collections.path
);

-- A ManaBox export was stored as one collection holding every binder in it. Each of its binders becomes a
-- binder of its own, named by its rows' Binder Name, and ManaBox decks become protected deck binders. The
-- binder holding the export's first row takes over the export's own row, so nothing is deleted. A ManaBox
-- collection already holding one binder of its own name is left alone, so running this again changes
-- nothing. manabox_binder_splits records each split.
CREATE TABLE IF NOT EXISTS manabox_binder_splits (
  user_id TEXT NOT NULL,
  collection_id TEXT NOT NULL, -- the export's row
  binder TEXT NOT NULL, -- the rows' Binder Name
  is_deck INTEGER NOT NULL,
  first_entry INTEGER NOT NULL,
  new_id TEXT NOT NULL, -- the binder's row: the export's own for the binder holding its first row
  new_name TEXT,
  skipped INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0
);

INSERT INTO manabox_binder_splits (user_id, collection_id, binder, is_deck, first_entry, new_id)
SELECT e.user_id, e.collection_id,
       COALESCE(NULLIF(TRIM(json_extract(e.source_record, '$."Binder Name"')), ''), c.name) AS binder,
       MAX(e.in_deck_binder), MIN(e.id), lower(hex(randomblob(16)))
FROM collection_entries e JOIN collections c ON c.id = e.collection_id AND c.user_id = e.user_id
WHERE c.format = 'manabox_csv' AND c.kind = 'binder'
GROUP BY e.user_id, e.collection_id, binder;

UPDATE manabox_binder_splits SET skipped = 1
WHERE done = 0 AND collection_id IN (
  SELECT s.collection_id FROM manabox_binder_splits s JOIN collections c ON c.id = s.collection_id
  WHERE s.done = 0
  GROUP BY s.collection_id
  HAVING COUNT(*) = 1 AND MAX(s.binder = c.name AND s.is_deck = 0) = 1
);

UPDATE manabox_binder_splits SET new_id = collection_id
WHERE done = 0 AND skipped = 0 AND first_entry = (
  SELECT MIN(o.first_entry) FROM manabox_binder_splits o
  WHERE o.collection_id = manabox_binder_splits.collection_id AND o.done = 0 AND o.skipped = 0
);

-- A binder whose name another binder of the person's already has (or that two exports share) is named
-- after its export too: "all cards (ManaBox_Collection)".
UPDATE manabox_binder_splits SET new_name = CASE
  WHEN EXISTS (
    SELECT 1 FROM collections c
    WHERE c.user_id = manabox_binder_splits.user_id AND c.name = manabox_binder_splits.binder
      AND c.id <> manabox_binder_splits.collection_id
  ) OR (
    SELECT COUNT(*) FROM manabox_binder_splits o
    WHERE o.user_id = manabox_binder_splits.user_id AND o.binder = manabox_binder_splits.binder
      AND o.done = 0 AND o.skipped = 0
  ) > 1
  THEN binder || ' (' || (SELECT name FROM collections WHERE id = manabox_binder_splits.collection_id) || ')'
  ELSE binder
END
WHERE done = 0 AND skipped = 0;

-- A name still taken leaves its rows where they are, rather than failing the migration.
INSERT OR IGNORE INTO collections (id, user_id, name, path, format, protected, kind, created_at, updated_at, revision)
SELECT s.new_id, s.user_id, s.new_name, 'collections/' || s.new_name || '.csv', 'manabox_csv',
       CASE WHEN s.is_deck = 1 THEN 1 ELSE c.protected END,
       CASE WHEN s.is_deck = 1 THEN 'deck' ELSE 'binder' END,
       c.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL
FROM manabox_binder_splits s JOIN collections c ON c.id = s.collection_id
WHERE s.done = 0 AND s.skipped = 0 AND s.new_id <> s.collection_id;

UPDATE OR IGNORE collections SET
  name = (SELECT s.new_name FROM manabox_binder_splits s WHERE s.new_id = collections.id AND s.done = 0),
  path = 'collections/' || (SELECT s.new_name FROM manabox_binder_splits s WHERE s.new_id = collections.id AND s.done = 0) || '.csv',
  kind = (SELECT CASE WHEN s.is_deck = 1 THEN 'deck' ELSE 'binder' END FROM manabox_binder_splits s
          WHERE s.new_id = collections.id AND s.done = 0),
  protected = CASE WHEN (SELECT s.is_deck FROM manabox_binder_splits s WHERE s.new_id = collections.id AND s.done = 0) = 1
                   THEN 1 ELSE protected END,
  revision = NULL
WHERE id IN (
  SELECT new_id FROM manabox_binder_splits WHERE done = 0 AND skipped = 0 AND new_id = collection_id
);

UPDATE collection_entries SET collection_id = (
  SELECT s.new_id FROM manabox_binder_splits s JOIN collections n ON n.id = s.new_id
  WHERE s.done = 0 AND s.skipped = 0 AND s.collection_id = collection_entries.collection_id
    AND s.binder = COALESCE(
      NULLIF(TRIM(json_extract(collection_entries.source_record, '$."Binder Name"')), ''),
      (SELECT name FROM collections WHERE id = collection_entries.collection_id)
    )
)
WHERE EXISTS (
  SELECT 1 FROM manabox_binder_splits s JOIN collections n ON n.id = s.new_id
  WHERE s.done = 0 AND s.skipped = 0 AND s.new_id <> s.collection_id
    AND s.collection_id = collection_entries.collection_id
    AND s.binder = COALESCE(
      NULLIF(TRIM(json_extract(collection_entries.source_record, '$."Binder Name"')), ''),
      (SELECT name FROM collections WHERE id = collection_entries.collection_id)
    )
);

-- Positions count from 0 in each binder, in the rows' original order (their IDs never change).
UPDATE collection_entries SET position = (
  SELECT COUNT(*) FROM collection_entries o
  WHERE o.user_id = collection_entries.user_id AND o.collection_id = collection_entries.collection_id
    AND o.id < collection_entries.id
)
WHERE collection_id IN (SELECT new_id FROM manabox_binder_splits WHERE done = 0 AND skipped = 0);

UPDATE manabox_binder_splits SET done = 1 WHERE done = 0;
