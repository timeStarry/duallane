ALTER TABLE users ADD COLUMN recall_reason TEXT;

ALTER TABLE messages ADD COLUMN recalled_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN recall_reason TEXT;

CREATE INDEX messages_recalled_at_idx ON messages (recalled_at);
