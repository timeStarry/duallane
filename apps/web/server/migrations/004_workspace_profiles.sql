ALTER TABLE users ADD COLUMN nickname TEXT;

UPDATE users
SET nickname = display_name
WHERE kind = 'human' AND nickname IS NULL;

CREATE TABLE user_remarks (
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  remark TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (owner_user_id, target_user_id),
  CHECK (owner_user_id <> target_user_id)
);

CREATE INDEX user_remarks_target_idx ON user_remarks (target_user_id);
