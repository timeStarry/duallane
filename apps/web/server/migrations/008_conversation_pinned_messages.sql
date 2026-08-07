CREATE TABLE conversation_pinned_messages (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  pinned_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (conversation_id, message_id)
);

CREATE TABLE conversation_pin_counters (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pin_count INTEGER NOT NULL DEFAULT 0 CHECK (pin_count >= 0 AND pin_count <= 3),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX conversation_pins_recent_idx
  ON conversation_pinned_messages (conversation_id, created_at DESC, message_id DESC);
