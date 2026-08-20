ALTER TABLE workspace_workflow_sessions ADD COLUMN client_invocation_id TEXT;
ALTER TABLE workspace_workflow_sessions ADD COLUMN start_request_hash TEXT;

UPDATE workspace_workflow_sessions AS workflow
SET status = 'conflicted'
WHERE workflow.status = 'active'
  AND workflow.conversation_id IS NOT NULL
  AND workflow.bot_user_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM workspace_workflow_sessions AS newer
    WHERE newer.status = 'active'
      AND newer.actor_user_id = workflow.actor_user_id
      AND newer.conversation_id = workflow.conversation_id
      AND newer.bot_user_id = workflow.bot_user_id
      AND (
        newer.updated_at > workflow.updated_at
        OR (newer.updated_at = workflow.updated_at AND newer.id > workflow.id)
      )
  );

CREATE UNIQUE INDEX workspace_workflows_foreground_active_unique
  ON workspace_workflow_sessions (actor_user_id, conversation_id, bot_user_id)
  WHERE status = 'active' AND conversation_id IS NOT NULL AND bot_user_id IS NOT NULL;

CREATE UNIQUE INDEX workspace_workflows_start_invocation_unique
  ON workspace_workflow_sessions (space_id, actor_user_id, client_invocation_id)
  WHERE client_invocation_id IS NOT NULL;

CREATE TABLE workspace_interaction_rate_limits (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, actor_user_id, bot_user_id, operation_key, window_started_at)
);

CREATE INDEX workspace_interaction_rate_limits_cleanup_idx
  ON workspace_interaction_rate_limits (updated_at);
