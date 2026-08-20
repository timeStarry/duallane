CREATE TABLE workspace_storage_objects (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE CHECK (LENGTH(sha256) = 64),
  object_key TEXT NOT NULL UNIQUE,
  byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
  content_type TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX workspace_storage_objects_available_idx
  ON workspace_storage_objects (created_at, id)
  WHERE deleted_at IS NULL;

ALTER TABLE attachments
  ADD COLUMN storage_object_id TEXT REFERENCES workspace_storage_objects(id) ON DELETE SET NULL;

ALTER TABLE users
  ADD COLUMN avatar_storage_object_id TEXT REFERENCES workspace_storage_objects(id) ON DELETE SET NULL;

ALTER TABLE workspace_custom_emotes
  ADD COLUMN storage_object_id TEXT REFERENCES workspace_storage_objects(id) ON DELETE SET NULL;

CREATE INDEX attachments_storage_object_idx
  ON attachments (storage_object_id)
  WHERE storage_object_id IS NOT NULL;

CREATE INDEX users_avatar_storage_object_idx
  ON users (avatar_storage_object_id)
  WHERE avatar_storage_object_id IS NOT NULL;

CREATE INDEX workspace_custom_emotes_storage_object_idx
  ON workspace_custom_emotes (storage_object_id)
  WHERE storage_object_id IS NOT NULL;
