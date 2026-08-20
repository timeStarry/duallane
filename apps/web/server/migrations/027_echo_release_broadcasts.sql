CREATE TABLE echo_release_publications (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  title TEXT NOT NULL,
  guide_hash TEXT NOT NULL CHECK (length(guide_hash) = 64),
  guide_json TEXT NOT NULL,
  published_by_user_id TEXT NOT NULL REFERENCES users(id),
  published_at TIMESTAMPTZ NOT NULL,
  UNIQUE (space_id, version)
);

CREATE INDEX echo_release_publications_space_published_idx
  ON echo_release_publications (space_id, published_at DESC, id DESC);

CREATE TABLE echo_release_deliveries (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  publication_id TEXT NOT NULL REFERENCES echo_release_publications(id) ON DELETE CASCADE,
  recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (publication_id, recipient_user_id)
);

CREATE INDEX echo_release_deliveries_status_idx
  ON echo_release_deliveries (space_id, status, updated_at, id);

CREATE INDEX echo_release_deliveries_recipient_idx
  ON echo_release_deliveries (recipient_user_id, created_at DESC, id DESC);
