-- Short-lived, owner-approved setup sessions bootstrap an external Agent
-- without placing a Bot token in a URL, prompt, or chat message.
CREATE TABLE workspace_agent_bot_setup_sessions (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES workspace_agent_bots(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'created',
  requested_scopes_json TEXT NOT NULL DEFAULT '[]',
  approved_scopes_json TEXT NOT NULL DEFAULT '[]',
  requested_conversations_json TEXT NOT NULL DEFAULT '[]',
  approved_conversations_json TEXT NOT NULL DEFAULT '[]',
  client_name TEXT,
  client_version TEXT,
  protocol_version TEXT NOT NULL DEFAULT 'v1',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  expires_at TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ,
  exchanged_at TIMESTAMPTZ,
  denied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX workspace_agent_bot_setup_sessions_bot_idx
  ON workspace_agent_bot_setup_sessions (bot_id, created_at DESC);

CREATE INDEX workspace_agent_bot_setup_sessions_expiry_idx
  ON workspace_agent_bot_setup_sessions (status, expires_at);
