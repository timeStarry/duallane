-- DualLane v1.0 Clean Architecture Schema & 0.20 -> v1.0 Data Migration

-- 1. Conversations: support native 'saved' (Saved Messages) lane
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_type_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_type_check CHECK (type IN ('direct', 'group', 'saved'));

-- 2. Conversation Members: true group-level role (decoupled from space-wide role)
ALTER TABLE conversation_members
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member'
  CHECK (role IN ('owner', 'admin', 'member'));

-- Backfill group creators as conversation owners
UPDATE conversation_members cm
SET role = 'owner'
FROM conversations c
WHERE cm.conversation_id = c.id
  AND c.type = 'group'
  AND c.created_by = cm.user_id
  AND cm.role = 'member';

-- 3. Messages: unified Thread-first model, forwarding metadata, and search indexing
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS thread_root_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS also_send_to_channel BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS thread_title TEXT,
  ADD COLUMN IF NOT EXISTS forwarded_from_json TEXT;

CREATE INDEX IF NOT EXISTS messages_thread_root_idx
  ON messages(thread_root_id, created_at ASC)
  WHERE thread_root_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS messages_plain_text_fts_idx
  ON messages USING gin (to_tsvector('simple', coalesce(plain_text, '')));

-- 4. Attachments: media dimensions, ThumbHash placeholder, audio waveform, and source message backlink
ALTER TABLE attachments
  ADD COLUMN IF NOT EXISTS width INTEGER,
  ADD COLUMN IF NOT EXISTS height INTEGER,
  ADD COLUMN IF NOT EXISTS duration_ms INTEGER,
  ADD COLUMN IF NOT EXISTS thumb_hash TEXT,
  ADD COLUMN IF NOT EXISTS waveform_json TEXT,
  ADD COLUMN IF NOT EXISTS source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS attachments_source_message_idx
  ON attachments(source_message_id)
  WHERE source_message_id IS NOT NULL;

-- Backfill source_message_id from existing message_attachments
UPDATE attachments a
SET source_message_id = ma.message_id
FROM (
  SELECT DISTINCT ON (attachment_id) attachment_id, message_id
  FROM message_attachments
  ORDER BY attachment_id, message_id
) ma
WHERE a.id = ma.attachment_id
  AND a.source_message_id IS NULL;

-- 5. Unified Multi-Device Sessions & Push Registry (replaces Android-only 035_mobile_sessions)
CREATE TABLE IF NOT EXISTS user_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('web', 'ios', 'android')),
  device_name TEXT NOT NULL,
  app_version TEXT NOT NULL DEFAULT '1.0.0',
  push_provider TEXT CHECK (push_provider IN ('apns', 'fcm', 'unifiedpush', 'ntfy')),
  push_token TEXT,
  token_hash TEXT UNIQUE,
  last_active_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS user_devices_user_idx ON user_devices(user_id) WHERE revoked_at IS NULL;

-- 6. Web-to-Mobile QR Instant Login
CREATE TABLE IF NOT EXISTS qr_login_sessions (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'exchanged', 'expired')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT CHECK (platform IN ('ios', 'android')),
  device_name TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);

-- 7. Unified User Preferences (decoupled from emote-settings)
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  prefs_json TEXT NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL
);

-- 8. Bot Platform v2: lift 1-bot-per-user limit, support Telegram privacy mode toggle, custom slash commands & signed outbound webhooks
DROP INDEX IF EXISTS workspace_agent_bots_active_owner_idx;
DROP INDEX IF EXISTS workspace_agent_bots_one_active_per_owner;

ALTER TABLE workspace_agent_bots
  DROP CONSTRAINT IF EXISTS workspace_agent_bots_trigger_policy_check;
ALTER TABLE workspace_agent_bots
  ADD CONSTRAINT workspace_agent_bots_trigger_policy_check CHECK (trigger_policy IN ('mention-or-command', 'all-messages'));

ALTER TABLE workspace_agent_bot_settings
  DROP CONSTRAINT IF EXISTS workspace_agent_bot_settings_trigger_policy_check;
ALTER TABLE workspace_agent_bot_settings
  ADD CONSTRAINT workspace_agent_bot_settings_trigger_policy_check CHECK (trigger_policy IN ('mention-or-command', 'all-messages'));

ALTER TABLE conversation_pin_counters
  DROP CONSTRAINT IF EXISTS conversation_pin_counters_pin_count_check;
ALTER TABLE conversation_pin_counters
  ADD CONSTRAINT conversation_pin_counters_pin_count_check CHECK (pin_count >= 0);

CREATE TABLE IF NOT EXISTS bot_commands (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES workspace_agent_bots(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  description TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'direct', 'group')),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (bot_id, command)
);

CREATE TABLE IF NOT EXISTS bot_webhooks (
  bot_id TEXT PRIMARY KEY REFERENCES workspace_agent_bots(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_status INTEGER,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL
);

-- 9. Migrate legacy 'usr_system_beacon' DMs to native 'saved' Saved Messages conversations
UPDATE conversations c
SET type = 'saved', title = '个人空间'
WHERE c.type = 'direct'
  AND EXISTS (
    SELECT 1 FROM conversation_members cm
    WHERE cm.conversation_id = c.id AND cm.user_id = 'usr_system_beacon'
  );
