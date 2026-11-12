-- Users who have signed in, and the audit log of security-relevant events.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  -- Google's stable account ID, pinned at first sign-in.
  google_sub TEXT NOT NULL UNIQUE,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_login_at TEXT NOT NULL
);

CREATE TABLE auth_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  email TEXT,
  ip TEXT,
  detail TEXT
);

CREATE INDEX auth_events_at ON auth_events (at);
CREATE INDEX auth_events_type_at ON auth_events (type, at);
