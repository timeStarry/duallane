ALTER TABLE workspace_emote_preferences
  ADD COLUMN auto_hide_messages BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE workspace_emote_preferences
  ADD COLUMN auto_hide_message_types_json TEXT NOT NULL DEFAULT '["image","emote","long"]';
