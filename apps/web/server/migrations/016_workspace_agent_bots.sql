CREATE TABLE workspace_agent_bots (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'external_agent' CHECK (mode = 'external_agent'),
  name TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  visibility_policy TEXT NOT NULL DEFAULT 'private' CHECK (visibility_policy IN ('private', 'specified_members', 'space_members', 'groups')),
  conversation_policy TEXT NOT NULL DEFAULT 'direct-only' CHECK (conversation_policy IN ('direct-only', 'group-capable')),
  trigger_policy TEXT NOT NULL DEFAULT 'mention-or-command' CHECK (trigger_policy = 'mention-or-command'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'deleting', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  deleting_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX workspace_agent_bots_active_owner_idx
  ON workspace_agent_bots (space_id, owner_user_id)
  WHERE status <> 'deleted';

CREATE INDEX workspace_agent_bots_space_status_idx
  ON workspace_agent_bots (space_id, status, created_at);
CREATE INDEX workspace_agent_bots_owner_idx
  ON workspace_agent_bots (owner_user_id, space_id);

CREATE TABLE workspace_agent_bot_tokens (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES workspace_agent_bots(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (LENGTH(token_hash) = 64),
  scopes_json TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX workspace_agent_bot_tokens_bot_idx
  ON workspace_agent_bot_tokens (bot_id, created_at DESC);
CREATE INDEX workspace_agent_bot_tokens_space_idx
  ON workspace_agent_bot_tokens (space_id, created_at DESC);
