-- Workspace presence is a short-lived connection lease, not an activity
-- history.  The connection id is intentionally opaque and contains no
-- session, transport, address, or message data.
CREATE TABLE IF NOT EXISTS workspace_presence_leases (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  lease_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (space_id, user_id, connection_id)
);

CREATE INDEX IF NOT EXISTS workspace_presence_user_expiry_idx
  ON workspace_presence_leases (space_id, user_id, lease_until);

CREATE INDEX IF NOT EXISTS workspace_presence_expiry_idx
  ON workspace_presence_leases (lease_until, space_id, user_id, connection_id);
