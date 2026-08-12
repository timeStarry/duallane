CREATE TABLE message_hidden_states (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  hidden_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, message_id)
);

CREATE INDEX message_hidden_states_message_idx
  ON message_hidden_states (message_id);
