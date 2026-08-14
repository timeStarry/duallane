-- Agent Bot Gateway policy, connection and delivery state.  Bot credentials
-- remain hashes in workspace_agent_bot_tokens; these tables only hold
-- authorization metadata and filtered event payloads.

CREATE TABLE workspace_agent_bot_settings (
  bot_id TEXT PRIMARY KEY REFERENCES workspace_agent_bots(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  visibility_policy TEXT NOT NULL DEFAULT 'private' CHECK (visibility_policy IN ('private', 'specified_members', 'space_members', 'groups')),
  allow_direct INTEGER NOT NULL DEFAULT 1 CHECK (allow_direct IN (0, 1)),
  allow_group INTEGER NOT NULL DEFAULT 0 CHECK (allow_group IN (0, 1)),
  group_inviter_policy TEXT NOT NULL DEFAULT 'owner' CHECK (group_inviter_policy IN ('owner', 'group_admin', 'any_member')),
  require_owner_approval INTEGER NOT NULL DEFAULT 1 CHECK (require_owner_approval IN (0, 1)),
  proactive_enabled INTEGER NOT NULL DEFAULT 0 CHECK (proactive_enabled IN (0, 1)),
  trigger_policy TEXT NOT NULL DEFAULT 'mention-or-command' CHECK (trigger_policy = 'mention-or-command'),
  welcome_message TEXT,
  description TEXT,
  avatar_url TEXT,
  show_creator INTEGER NOT NULL DEFAULT 0 CHECK (show_creator IN (0, 1)),
  max_context_messages INTEGER NOT NULL DEFAULT 50 CHECK (max_context_messages > 0 AND max_context_messages <= 200),
  max_context_chars INTEGER NOT NULL DEFAULT 20000 CHECK (max_context_chars > 0 AND max_context_chars <= 200000),
  max_context_tokens INTEGER NOT NULL DEFAULT 8000 CHECK (max_context_tokens > 0 AND max_context_tokens <= 100000),
  context_window_seconds INTEGER NOT NULL DEFAULT 86400 CHECK (context_window_seconds > 0 AND context_window_seconds <= 2592000),
  include_replies INTEGER NOT NULL DEFAULT 1 CHECK (include_replies IN (0, 1)),
  include_system_events INTEGER NOT NULL DEFAULT 0 CHECK (include_system_events IN (0, 1)),
  include_attachment_metadata INTEGER NOT NULL DEFAULT 0 CHECK (include_attachment_metadata IN (0, 1)),
  allow_attachment_preview INTEGER NOT NULL DEFAULT 0 CHECK (allow_attachment_preview IN (0, 1)),
  long_term_summary_enabled INTEGER NOT NULL DEFAULT 0 CHECK (long_term_summary_enabled IN (0, 1)),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (bot_id, space_id)
);

CREATE INDEX workspace_agent_bot_settings_space_idx
  ON workspace_agent_bot_settings (space_id, updated_at DESC);

CREATE TABLE workspace_agent_bot_visibility_members (
  bot_id TEXT NOT NULL REFERENCES workspace_agent_bots(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (bot_id, user_id),
  UNIQUE (bot_id, space_id, user_id)
);

CREATE INDEX workspace_agent_bot_visibility_members_user_idx
  ON workspace_agent_bot_visibility_members (space_id, user_id);

CREATE TABLE workspace_agent_bot_limits (
  bot_id TEXT PRIMARY KEY REFERENCES workspace_agent_bots(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  requests_per_minute INTEGER NOT NULL DEFAULT 30 CHECK (requests_per_minute > 0 AND requests_per_minute <= 10000),
  member_daily_requests INTEGER NOT NULL DEFAULT 500 CHECK (member_daily_requests > 0 AND member_daily_requests <= 100000),
  input_token_limit INTEGER NOT NULL DEFAULT 32000 CHECK (input_token_limit > 0 AND input_token_limit <= 1000000),
  output_token_limit INTEGER NOT NULL DEFAULT 16000 CHECK (output_token_limit > 0 AND output_token_limit <= 1000000),
  max_concurrency INTEGER NOT NULL DEFAULT 2 CHECK (max_concurrency > 0 AND max_concurrency <= 100),
  event_backlog_limit INTEGER NOT NULL DEFAULT 200 CHECK (event_backlog_limit > 0 AND event_backlog_limit <= 10000),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (bot_id, space_id)
);

CREATE TABLE workspace_agent_bot_group_policies (
  bot_id TEXT NOT NULL REFERENCES workspace_agent_bots(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'rejected', 'removed')),
  invited_by TEXT REFERENCES users(id),
  approved_by TEXT REFERENCES users(id),
  max_context_messages INTEGER,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (bot_id, conversation_id),
  UNIQUE (bot_id, space_id, conversation_id)
);

CREATE INDEX workspace_agent_bot_group_policies_conversation_idx
  ON workspace_agent_bot_group_policies (conversation_id, status);

CREATE TABLE workspace_agent_bot_context_grants (
  grant_id TEXT NOT NULL UNIQUE,
  bot_id TEXT NOT NULL REFERENCES workspace_agent_bots(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  allow_trigger INTEGER NOT NULL DEFAULT 1 CHECK (allow_trigger IN (0, 1)),
  allow_context INTEGER NOT NULL DEFAULT 0 CHECK (allow_context IN (0, 1)),
  max_messages INTEGER,
  granted_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (bot_id, conversation_id),
  UNIQUE (bot_id, space_id, conversation_id)
);

CREATE INDEX workspace_agent_bot_context_grants_conversation_idx
  ON workspace_agent_bot_context_grants (conversation_id, allow_context);

CREATE TABLE workspace_agent_bot_connections (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES workspace_agent_bots(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected', 'connected', 'paused', 'revoked')),
  adapter_version TEXT,
  connection_nonce TEXT,
  connected_at TIMESTAMPTZ,
  disconnected_at TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ,
  last_processed_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (bot_id),
  UNIQUE (bot_id, space_id)
);

CREATE INDEX workspace_agent_bot_connections_status_idx
  ON workspace_agent_bot_connections (space_id, status, updated_at DESC);

CREATE TABLE workspace_agent_bot_deliveries (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES workspace_agent_bots(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  sequence BIGINT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  conversation_id TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'delivered', 'acked', 'expired')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TIMESTAMPTZ NOT NULL,
  delivered_at TIMESTAMPTZ,
  acked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (bot_id, sequence),
  UNIQUE (bot_id, event_id)
);

CREATE INDEX workspace_agent_bot_deliveries_replay_idx
  ON workspace_agent_bot_deliveries (bot_id, sequence);

CREATE TABLE workspace_agent_bot_idempotency (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES workspace_agent_bots(id) ON DELETE CASCADE,
  token_id TEXT NOT NULL REFERENCES workspace_agent_bot_tokens(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (bot_id, operation, idempotency_key)
);

CREATE INDEX workspace_agent_bot_idempotency_expiry_idx
  ON workspace_agent_bot_idempotency (bot_id, expires_at);

CREATE TABLE workspace_agent_bot_cards (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES workspace_agent_bots(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  card_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  fallback_text TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX workspace_agent_bot_cards_conversation_idx
  ON workspace_agent_bot_cards (conversation_id, status, updated_at DESC);
