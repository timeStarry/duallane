CREATE TABLE member_visibility_grants (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  viewer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  visible_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, viewer_user_id, visible_user_id),
  CHECK (viewer_user_id <> visible_user_id)
);

CREATE INDEX member_visibility_grants_viewer_idx
  ON member_visibility_grants (space_id, viewer_user_id);