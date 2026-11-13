-- How many times each signed link (src/links.mjs) has been opened, so a link works only a few times.
-- Rows are deleted once their link has expired.
CREATE TABLE link_uses (
  nonce TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL, -- milliseconds since the epoch, as in the link
  uses INTEGER NOT NULL
);

CREATE INDEX link_uses_expires_at ON link_uses (expires_at);
