CREATE TABLE topics (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'archived')),
  allow_sync_to_group BOOLEAN NOT NULL DEFAULT FALSE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  UNIQUE (space_id, created_by, idempotency_key)
);

CREATE TABLE topic_members (
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL,
  left_at TIMESTAMPTZ,
  last_read_message_id TEXT,
  last_read_seq BIGINT,
  notification_level TEXT NOT NULL DEFAULT 'all'
    CHECK (notification_level IN ('all', 'mentions', 'muted')),
  PRIMARY KEY (topic_id, user_id)
);

CREATE INDEX topics_conversation_status_idx
  ON topics (conversation_id, status, updated_at DESC);
CREATE INDEX topics_space_created_idx
  ON topics (space_id, created_at DESC);
CREATE INDEX topic_members_user_active_idx
  ON topic_members (user_id, joined_at DESC)
  WHERE left_at IS NULL;
CREATE INDEX topic_members_topic_active_idx
  ON topic_members (topic_id, joined_at)
  WHERE left_at IS NULL;
