-- Opt-in policy V2 preserves legacy authorization until explicitly configured.
ALTER TABLE workspace_agent_bot_settings ADD COLUMN access_policy JSONB;
ALTER TABLE workspace_agent_bot_settings ADD CONSTRAINT bot_access_policy_object
  CHECK (access_policy IS NULL OR jsonb_typeof(access_policy) = 'object');

-- Task authorization is content-free. Inputs are identified by message ID/hash;
-- all content remains in the existing message/attachment retention domains.
CREATE TABLE workspace_agent_tasks (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES workspace_agent_bots(id) ON DELETE CASCADE,
  token_id TEXT NOT NULL REFERENCES workspace_agent_bot_tokens(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  trigger_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  requestor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  root_task_id TEXT NOT NULL REFERENCES workspace_agent_tasks(id) ON DELETE CASCADE,
  parent_task_id TEXT REFERENCES workspace_agent_tasks(id) ON DELETE CASCADE,
  input_hash TEXT NOT NULL,
  authorization_hash TEXT NOT NULL,
  depth INTEGER NOT NULL CHECK (depth BETWEEN 0 AND 6),
  reads_used INTEGER NOT NULL DEFAULT 0 CHECK (reads_used BETWEEN 0 AND 64),
  read_bytes BIGINT NOT NULL DEFAULT 0 CHECK (read_bytes BETWEEN 0 AND 33554432),
  writes_used INTEGER NOT NULL DEFAULT 0 CHECK (writes_used BETWEEN 0 AND 24),
  children_used INTEGER NOT NULL DEFAULT 0 CHECK (children_used BETWEEN 0 AND 12),
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (bot_id, event_id)
);
CREATE INDEX workspace_agent_tasks_expiry_idx ON workspace_agent_tasks(expires_at);
CREATE INDEX workspace_agent_tasks_root_idx ON workspace_agent_tasks(root_task_id);

-- The gateway records provenance in the same transaction as message creation.
-- IDs supplied by a client can never mint an independent root authorization.
CREATE TABLE workspace_agent_message_origins (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES workspace_agent_tasks(id) ON DELETE CASCADE
);
CREATE INDEX workspace_agent_message_origins_task_idx ON workspace_agent_message_origins(task_id);

CREATE TABLE workspace_agent_upload_origins (
  upload_id TEXT PRIMARY KEY REFERENCES transfer_ledger(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES workspace_agent_tasks(id) ON DELETE CASCADE
);
CREATE INDEX workspace_agent_upload_origins_task_idx ON workspace_agent_upload_origins(task_id);

CREATE TABLE workspace_agent_task_operations (
  task_id TEXT NOT NULL REFERENCES workspace_agent_tasks(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  PRIMARY KEY(task_id, operation, idempotency_key),
  FOREIGN KEY(bot_id, operation, idempotency_key)
    REFERENCES workspace_agent_bot_idempotency(bot_id, operation, idempotency_key) ON DELETE CASCADE
);
