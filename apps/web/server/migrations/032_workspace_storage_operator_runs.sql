CREATE TABLE workspace_storage_operator_runs (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK (operation IN ('backfill', 'migrate')),
  state TEXT NOT NULL CHECK (state IN ('running', 'paused', 'completed', 'failed', 'rolled_back')),
  active_operation TEXT UNIQUE,
  schema_fingerprint TEXT NOT NULL CHECK (LENGTH(schema_fingerprint) > 0),
  fence_token_hash TEXT NOT NULL CHECK (LENGTH(fence_token_hash) = 64),
  phase TEXT NOT NULL DEFAULT 'root' CHECK (phase IN ('root', 'clone')),
  cursor_kind TEXT,
  cursor_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  total_items INTEGER NOT NULL DEFAULT 0 CHECK (total_items >= 0),
  processed_items INTEGER NOT NULL DEFAULT 0 CHECK (processed_items >= 0),
  last_error_code TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (
    (state IN ('running', 'paused') AND active_operation IS NOT NULL AND active_operation = operation)
    OR (state IN ('completed', 'failed', 'rolled_back') AND active_operation IS NULL)
  )
);

CREATE TABLE workspace_storage_operator_items (
  run_id TEXT NOT NULL REFERENCES workspace_storage_operator_runs(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK (phase IN ('root', 'clone')),
  kind TEXT NOT NULL CHECK (kind IN ('attachment', 'avatar', 'customEmote')),
  resource_id TEXT NOT NULL,
  space_id TEXT,
  legacy_storage_key TEXT,
  existing_storage_object_id TEXT,
  source_custom_emote_id TEXT,
  content_type TEXT,
  expected_sha256 TEXT,
  expected_byte_size INTEGER CHECK (expected_byte_size IS NULL OR expected_byte_size >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  storage_object_id TEXT,
  sha256 TEXT,
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
  object_key TEXT,
  action TEXT CHECK (action IS NULL OR action IN ('created', 'reused', 'bound_clone')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_error_code TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, phase, kind, resource_id)
);

CREATE INDEX workspace_storage_operator_items_page_idx
  ON workspace_storage_operator_items (run_id, phase, kind, resource_id);

CREATE INDEX workspace_storage_operator_items_status_idx
  ON workspace_storage_operator_items (run_id, phase, status, kind, resource_id);
