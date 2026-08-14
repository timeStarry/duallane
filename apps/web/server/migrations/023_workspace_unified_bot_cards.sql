-- Bot Gateway cards now use the shared workspace_cards authority. Keep the
-- legacy table available for rollback/inspection, but never read it from
-- production code after this idempotent backfill.
INSERT INTO workspace_cards (
  id, space_id, conversation_id, card_type, schema_version, payload_json, fallback_text,
  source_kind, source_id, resource_type, resource_id, visibility_scope,
  created_by_user_id, status, revision, expires_at, created_at, updated_at
)
SELECT
  legacy.id,
  legacy.space_id,
  legacy.conversation_id,
  legacy.card_type,
  legacy.schema_version,
  legacy.payload_json,
  legacy.fallback_text,
  'custom_bot',
  legacy.id,
  NULL,
  NULL,
  'conversation',
  bot.bot_user_id,
  CASE legacy.status WHEN 'deleted' THEN 'invalidated' ELSE legacy.status END,
  legacy.revision,
  NULL,
  legacy.created_at,
  legacy.updated_at
FROM workspace_agent_bot_cards legacy
LEFT JOIN workspace_agent_bots bot
  ON bot.id = legacy.bot_id
WHERE legacy.id IS NOT NULL
ON CONFLICT DO NOTHING;
