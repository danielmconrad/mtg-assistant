-- Files uploaded on the upload page. Each preview stores the file in R2 (raw_key) and a row here; the
-- page's apply form names the row and carries its CSRF token, and applying moves status from pending
-- to applied exactly once. base_revision is the collection's revision when previewed, so a collection
-- changed since then refuses the apply.
CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  collection_name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('merge', 'replace')),
  format TEXT NOT NULL CHECK (format IN ('manabox_csv', 'text')),
  file_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  raw_key TEXT NOT NULL,
  csrf TEXT NOT NULL,
  base_revision TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applying', 'applied', 'failed', 'discarded')),
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX uploads_user ON uploads (user_id, created_at);
