CREATE TABLE space_email_settings (
  space_id TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL CHECK (smtp_port > 0 AND smtp_port <= 65535),
  encryption TEXT NOT NULL CHECK (encryption IN ('starttls', 'tls', 'none')),
  username TEXT,
  from_address TEXT NOT NULL,
  from_name TEXT NOT NULL,
  password_ciphertext TEXT,
  active_from TIMESTAMPTZ,
  last_tested_at TIMESTAMPTZ,
  last_test_status TEXT CHECK (last_test_status IN ('success', 'failure')),
  last_test_error_code TEXT,
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE user_notification_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  email_source TEXT NOT NULL DEFAULT 'github' CHECK (email_source IN ('github', 'custom')),
  email_verified_at TIMESTAMPTZ,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  immediate_enabled INTEGER NOT NULL DEFAULT 0 CHECK (immediate_enabled IN (0, 1)),
  digest_enabled INTEGER NOT NULL DEFAULT 1 CHECK (digest_enabled IN (0, 1)),
  updated_at TIMESTAMPTZ NOT NULL
);

INSERT INTO user_notification_preferences (
  user_id, email, email_source, email_verified_at, enabled, immediate_enabled, digest_enabled, updated_at
)
SELECT
  id,
  email,
  'github',
  CASE WHEN email IS NOT NULL THEN created_at ELSE NULL END,
  1,
  0,
  1,
  created_at
FROM users
WHERE kind = 'human';

CREATE TABLE notification_email_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pending_email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX notification_email_challenges_user_created_idx
  ON notification_email_challenges (user_id, created_at DESC);
