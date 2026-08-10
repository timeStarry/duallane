ALTER TABLE transfer_ledger ADD COLUMN last_activity_at TIMESTAMPTZ;

UPDATE transfer_ledger
SET last_activity_at = created_at
WHERE last_activity_at IS NULL;

CREATE TABLE workspace_upload_parts (
  upload_id TEXT NOT NULL REFERENCES transfer_ledger(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK (part_number > 0 AND part_number <= 10000),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  sha256 TEXT NOT NULL CHECK (LENGTH(sha256) = 64),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (upload_id, part_number)
);

CREATE TABLE workspace_emote_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled_pack_ids_json TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE workspace_custom_emotes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('upload', 'attachment', 'builtin', 'custom')),
  source_attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
  source_custom_emote_id TEXT REFERENCES workspace_custom_emotes(id) ON DELETE SET NULL,
  source_emote_key TEXT,
  original_file_name TEXT,
  original_mime_type TEXT,
  label TEXT NOT NULL,
  normalized_mime_type TEXT,
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size > 0),
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  frame_count INTEGER CHECK (frame_count IS NULL OR frame_count > 0),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  sha256 TEXT CHECK (sha256 IS NULL OR LENGTH(sha256) = 64),
  storage_key TEXT,
  sort_order INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX workspace_custom_emotes_user_order_idx
  ON workspace_custom_emotes (user_id, sort_order, created_at);

CREATE UNIQUE INDEX workspace_custom_emotes_user_sha_idx
  ON workspace_custom_emotes (user_id, sha256)
  WHERE sha256 IS NOT NULL;

CREATE UNIQUE INDEX workspace_custom_emotes_user_builtin_idx
  ON workspace_custom_emotes (user_id, source_emote_key)
  WHERE source_emote_key IS NOT NULL;

CREATE TABLE message_custom_emotes (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  custom_emote_id TEXT NOT NULL REFERENCES workspace_custom_emotes(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, custom_emote_id)
);

CREATE INDEX message_custom_emotes_emote_idx
  ON message_custom_emotes (custom_emote_id, message_id);
