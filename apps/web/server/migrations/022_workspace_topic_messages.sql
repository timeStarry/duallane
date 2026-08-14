ALTER TABLE messages
  ADD COLUMN topic_id TEXT REFERENCES topics(id) ON DELETE CASCADE;

CREATE INDEX messages_topic_created_idx
  ON messages (topic_id, created_at DESC, id DESC)
  WHERE topic_id IS NOT NULL;

CREATE UNIQUE INDEX messages_topic_client_id_unique
  ON messages (topic_id, author_id, client_message_id)
  WHERE topic_id IS NOT NULL AND author_id IS NOT NULL AND client_message_id IS NOT NULL;

CREATE TABLE topic_group_projections (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  topic_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  group_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  group_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  projection_type TEXT NOT NULL DEFAULT 'group_sync'
    CHECK (projection_type IN ('group_sync')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  removed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX topic_group_projection_active_message_idx
  ON topic_group_projections (topic_message_id)
  WHERE removed_at IS NULL;

CREATE INDEX topic_group_projections_topic_idx
  ON topic_group_projections (topic_id, created_at DESC, id DESC);

CREATE INDEX topic_members_read_idx
  ON topic_members (topic_id, user_id, last_read_seq);
