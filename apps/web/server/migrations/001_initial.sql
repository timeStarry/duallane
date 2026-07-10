CREATE TABLE users (
  id TEXT PRIMARY KEY,
  github_id TEXT UNIQUE,
  github_login TEXT NOT NULL UNIQUE,
  email TEXT,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  kind TEXT NOT NULL DEFAULT 'human' CHECK (kind IN ('human', 'bot', 'system')),
  created_at TIMESTAMPTZ NOT NULL,
  last_login_at TIMESTAMPTZ
);

CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE space_members (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'auditor')),
  joined_at TIMESTAMPTZ NOT NULL,
  removed_at TIMESTAMPTZ,
  PRIMARY KEY (space_id, user_id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  code_preview TEXT NOT NULL,
  default_role TEXT NOT NULL CHECK (default_role IN ('owner', 'admin', 'member', 'auditor')),
  created_by TEXT NOT NULL REFERENCES users(id),
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  uses INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('direct', 'group')),
  title TEXT NOT NULL,
  direct_key TEXT,
  retention_count INTEGER NOT NULL DEFAULT 10000 CHECK (retention_count > 0),
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (space_id, direct_key)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('human', 'bot', 'system')),
  kind TEXT NOT NULL CHECK (kind IN ('user', 'bot', 'system')),
  client_message_id TEXT,
  content_format TEXT NOT NULL,
  content_json TEXT NOT NULL,
  plain_text TEXT NOT NULL,
  reply_to_message_id TEXT REFERENCES messages(id),
  created_at TIMESTAMPTZ NOT NULL,
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  UNIQUE (space_id, conversation_id, author_id, client_message_id)
);

CREATE TABLE conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL,
  removed_at TIMESTAMPTZ,
  last_read_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  last_read_at TIMESTAMPTZ,
  last_read_seq BIGINT,
  notification_level TEXT NOT NULL DEFAULT 'all' CHECK (notification_level IN ('all', 'mentions', 'muted')),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  uploader_id TEXT NOT NULL REFERENCES users(id),
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private_staging', 'conversation', 'space')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'available', 'failed', 'removed')),
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
  storage_key TEXT,
  upload_transfer_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ
);

CREATE TABLE message_attachments (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, attachment_id)
);

CREATE TABLE transfer_ledger (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  direction TEXT NOT NULL CHECK (direction IN ('upload', 'download')),
  byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'completed', 'released', 'failed', 'rejected')),
  attachment_id TEXT REFERENCES attachments(id),
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ
);

CREATE TABLE workspace_events (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  type TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id),
  conversation_id TEXT REFERENCES conversations(id),
  target_type TEXT,
  target_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (space_id, seq)
);

CREATE TABLE workspace_event_cursors (
  space_id TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
  next_seq BIGINT NOT NULL CHECK (next_seq > 0)
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  space_id TEXT REFERENCES spaces(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES users(id),
  actor_github_login TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  result TEXT NOT NULL CHECK (result IN ('success', 'failure', 'rejected')),
  reason TEXT,
  ip_address TEXT,
  user_agent TEXT,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX workspace_events_space_created_idx ON workspace_events (space_id, created_at);
CREATE INDEX messages_conversation_created_idx ON messages (conversation_id, created_at DESC, id DESC);
CREATE INDEX transfer_ledger_quota_idx ON transfer_ledger (space_id, user_id, created_at, status);
CREATE INDEX audit_logs_space_created_idx ON audit_logs (space_id, created_at DESC);
