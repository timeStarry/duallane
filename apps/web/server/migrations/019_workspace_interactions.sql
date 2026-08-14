CREATE TABLE workspace_cards (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  card_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  payload_json TEXT NOT NULL,
  fallback_text TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('workspace', 'system_bot', 'custom_bot', 'echo', 'topic')),
  source_id TEXT,
  resource_type TEXT,
  resource_id TEXT,
  visibility_scope TEXT NOT NULL CHECK (visibility_scope IN ('space', 'conversation', 'resource')),
  created_by_user_id TEXT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invalidated', 'expired')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (space_id, source_kind, source_id, card_type)
);

CREATE INDEX workspace_cards_space_status_idx
  ON workspace_cards (space_id, status, updated_at DESC, id DESC);
CREATE INDEX workspace_cards_conversation_idx
  ON workspace_cards (conversation_id, updated_at DESC, id DESC);
CREATE INDEX workspace_cards_resource_idx
  ON workspace_cards (space_id, resource_type, resource_id, updated_at DESC);

CREATE TABLE workspace_card_action_runs (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES workspace_cards(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_id TEXT NOT NULL,
  client_action_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK (expected_revision > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  result_json TEXT,
  error_code TEXT,
  resulting_revision INTEGER,
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  UNIQUE (card_id, actor_user_id, client_action_id)
);

CREATE INDEX workspace_card_actions_card_idx
  ON workspace_card_action_runs (card_id, created_at DESC);

CREATE TABLE workspace_command_runs (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  command_name TEXT NOT NULL,
  command_version INTEGER NOT NULL CHECK (command_version > 0),
  client_invocation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'cancelled', 'timed_out')),
  result_card_id TEXT REFERENCES workspace_cards(id) ON DELETE SET NULL,
  result_json TEXT,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  UNIQUE (space_id, actor_user_id, client_invocation_id)
);

CREATE INDEX workspace_command_runs_actor_idx
  ON workspace_command_runs (space_id, actor_user_id, created_at DESC);

CREATE TABLE workspace_workflow_sessions (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  workflow_type TEXT NOT NULL,
  workflow_version INTEGER NOT NULL CHECK (workflow_version > 0),
  state_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled', 'expired', 'conflicted')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX workspace_workflows_actor_active_idx
  ON workspace_workflow_sessions (space_id, actor_user_id, updated_at DESC)
  WHERE status = 'active';
