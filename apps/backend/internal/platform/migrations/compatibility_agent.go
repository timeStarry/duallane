package migrations

import (
	"context"
	"errors"
	"strings"
)

// These fixed catalog queries inspect only the schema objects introduced by
// migration 037. They deliberately select the complete new-table shape and
// the one altered settings column so an old or partially applied bridge cannot
// pass by merely exposing a subset of the task tables. No application rows or
// policy/token values are read.
const compatibleAgentColumnsSQL = `SELECT table_name || '.' || column_name,
  data_type || '|' || is_nullable || '|' || COALESCE(column_default, '') || '|' ||
  is_identity || '|' || is_generated || '|' || COALESCE(domain_schema, '') || '.' || COALESCE(domain_name, '')
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND (
    (table_name = 'workspace_agent_bot_settings' AND column_name = 'access_policy')
    OR table_name IN ('workspace_agent_tasks', 'workspace_agent_message_origins',
      'workspace_agent_upload_origins', 'workspace_agent_task_operations')
  )
ORDER BY table_name, column_name`

const compatibleAgentConstraintsSQL = `SELECT relation.relname || '.' || constraint_row.conname,
  pg_get_constraintdef(constraint_row.oid, false) || '|' ||
  constraint_row.convalidated::text || '|' || constraint_row.condeferrable::text || '|' || constraint_row.condeferred::text
FROM pg_catalog.pg_constraint AS constraint_row
JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_row.conrelid
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = current_schema() AND relation.relkind = 'r'
  AND (
    (relation.relname = 'workspace_agent_bot_settings' AND constraint_row.conname = 'bot_access_policy_object')
    OR relation.relname IN ('workspace_agent_tasks', 'workspace_agent_message_origins',
      'workspace_agent_upload_origins', 'workspace_agent_task_operations')
  )
ORDER BY relation.relname, constraint_row.conname`

const compatibleAgentIndexesSQL = `SELECT relation.relname || '.' || index_relation.relname,
  access_method.amname || '|' || index_row.indisunique::text || '|' ||
  index_row.indisvalid::text || '|' || index_row.indisready::text || '|' ||
  COALESCE(pg_get_expr(index_row.indpred, index_row.indrelid), '') || '|' ||
  COALESCE(pg_get_expr(index_row.indexprs, index_row.indrelid), '') || '|' ||
  (SELECT string_agg(pg_get_indexdef(index_row.indexrelid, position, false), ',' ORDER BY position)
   FROM generate_series(1, index_row.indnatts) AS position)
FROM pg_catalog.pg_index AS index_row
JOIN pg_catalog.pg_class AS relation ON relation.oid = index_row.indrelid
JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
JOIN pg_catalog.pg_am AS access_method ON access_method.oid = index_relation.relam
WHERE namespace.nspname = current_schema() AND relation.relkind = 'r'
  AND relation.relname IN ('workspace_agent_tasks', 'workspace_agent_message_origins',
    'workspace_agent_upload_origins', 'workspace_agent_task_operations')
ORDER BY relation.relname, index_relation.relname`

func inspectReviewed037Schema(ctx context.Context, queryer Queryer) error {
	columns := map[string]string{
		"workspace_agent_bot_settings.access_policy":      "jsonb|YES||NO|NEVER|.",
		"workspace_agent_message_origins.message_id":      "text|NO||NO|NEVER|.",
		"workspace_agent_message_origins.task_id":         "text|NO||NO|NEVER|.",
		"workspace_agent_tasks.authorization_hash":        "text|NO||NO|NEVER|.",
		"workspace_agent_tasks.bot_id":                    "text|NO||NO|NEVER|.",
		"workspace_agent_tasks.cancelled_at":              "timestamp with time zone|YES||NO|NEVER|.",
		"workspace_agent_tasks.children_used":             "integer|NO|0|NO|NEVER|.",
		"workspace_agent_tasks.conversation_id":           "text|NO||NO|NEVER|.",
		"workspace_agent_tasks.created_at":                "timestamp with time zone|NO||NO|NEVER|.",
		"workspace_agent_tasks.depth":                     "integer|NO||NO|NEVER|.",
		"workspace_agent_tasks.event_id":                  "text|NO||NO|NEVER|.",
		"workspace_agent_tasks.expires_at":                "timestamp with time zone|NO||NO|NEVER|.",
		"workspace_agent_tasks.id":                        "text|NO||NO|NEVER|.",
		"workspace_agent_tasks.input_hash":                "text|NO||NO|NEVER|.",
		"workspace_agent_tasks.parent_task_id":            "text|YES||NO|NEVER|.",
		"workspace_agent_tasks.read_bytes":                "bigint|NO|0|NO|NEVER|.",
		"workspace_agent_tasks.reads_used":                "integer|NO|0|NO|NEVER|.",
		"workspace_agent_tasks.requestor_user_id":         "text|NO||NO|NEVER|.",
		"workspace_agent_tasks.root_task_id":              "text|NO||NO|NEVER|.",
		"workspace_agent_tasks.token_id":                  "text|NO||NO|NEVER|.",
		"workspace_agent_tasks.trigger_message_id":        "text|NO||NO|NEVER|.",
		"workspace_agent_tasks.space_id":                  "text|NO||NO|NEVER|.",
		"workspace_agent_tasks.writes_used":               "integer|NO|0|NO|NEVER|.",
		"workspace_agent_upload_origins.task_id":          "text|NO||NO|NEVER|.",
		"workspace_agent_upload_origins.upload_id":        "text|NO||NO|NEVER|.",
		"workspace_agent_task_operations.bot_id":          "text|NO||NO|NEVER|.",
		"workspace_agent_task_operations.idempotency_key": "text|NO||NO|NEVER|.",
		"workspace_agent_task_operations.operation":       "text|NO||NO|NEVER|.",
		"workspace_agent_task_operations.task_id":         "text|NO||NO|NEVER|.",
	}
	constraints := map[string]string{
		"workspace_agent_bot_settings.bot_access_policy_object":                                           "CHECK (((access_policy IS NULL) OR (jsonb_typeof(access_policy) = 'object'::text)))|true|false|false",
		"workspace_agent_message_origins.workspace_agent_message_origins_message_id_fkey":                 "FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE|true|false|false",
		"workspace_agent_message_origins.workspace_agent_message_origins_pkey":                            "PRIMARY KEY (message_id)|true|false|false",
		"workspace_agent_message_origins.workspace_agent_message_origins_task_id_fkey":                    "FOREIGN KEY (task_id) REFERENCES workspace_agent_tasks(id) ON DELETE CASCADE|true|false|false",
		"workspace_agent_tasks.workspace_agent_tasks_bot_id_event_id_key":                                 "UNIQUE (bot_id, event_id)|true|false|false",
		"workspace_agent_tasks.workspace_agent_tasks_bot_id_fkey":                                         "FOREIGN KEY (bot_id) REFERENCES workspace_agent_bots(id) ON DELETE CASCADE|true|false|false",
		"workspace_agent_tasks.workspace_agent_tasks_children_used_check":                                 "CHECK (((children_used >= 0) AND (children_used <= 12)))|true|false|false",
		"workspace_agent_tasks.workspace_agent_tasks_conversation_id_fkey":                                "FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE|true|false|false",
		"workspace_agent_tasks.workspace_agent_tasks_depth_check":                                         "CHECK (((depth >= 0) AND (depth <= 6)))|true|false|false",
		"workspace_agent_tasks.workspace_agent_tasks_parent_task_id_fkey":                                 "FOREIGN KEY (parent_task_id) REFERENCES workspace_agent_tasks(id) ON DELETE CASCADE|true|false|false",
		"workspace_agent_tasks.workspace_agent_tasks_pkey":                                                "PRIMARY KEY (id)|true|false|false",
		"workspace_agent_tasks.workspace_agent_tasks_read_bytes_check":                                    "CHECK (((read_bytes >= 0) AND (read_bytes <= 33554432)))|true|false|false",
		"workspace_agent_tasks.workspace_agent_tasks_reads_used_check":                                    "CHECK (((reads_used >= 0) AND (reads_used <= 64)))|true|false|false",
		"workspace_agent_tasks.workspace_agent_tasks_requestor_user_id_fkey":                              "FOREIGN KEY (requestor_user_id) REFERENCES users(id) ON DELETE CASCADE|true|false|false",
		"workspace_agent_tasks.workspace_agent_tasks_root_task_id_fkey":                                   "FOREIGN KEY (root_task_id) REFERENCES workspace_agent_tasks(id) ON DELETE CASCADE|true|false|false",
		"workspace_agent_tasks.workspace_agent_tasks_space_id_fkey":                                       "FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE|true|false|false",
		"workspace_agent_tasks.workspace_agent_tasks_token_id_fkey":                                       "FOREIGN KEY (token_id) REFERENCES workspace_agent_bot_tokens(id) ON DELETE CASCADE|true|false|false",
		"workspace_agent_tasks.workspace_agent_tasks_trigger_message_id_fkey":                             "FOREIGN KEY (trigger_message_id) REFERENCES messages(id) ON DELETE CASCADE|true|false|false",
		"workspace_agent_tasks.workspace_agent_tasks_writes_used_check":                                   "CHECK (((writes_used >= 0) AND (writes_used <= 24)))|true|false|false",
		"workspace_agent_upload_origins.workspace_agent_upload_origins_pkey":                              "PRIMARY KEY (upload_id)|true|false|false",
		"workspace_agent_upload_origins.workspace_agent_upload_origins_task_id_fkey":                      "FOREIGN KEY (task_id) REFERENCES workspace_agent_tasks(id) ON DELETE CASCADE|true|false|false",
		"workspace_agent_upload_origins.workspace_agent_upload_origins_upload_id_fkey":                    "FOREIGN KEY (upload_id) REFERENCES transfer_ledger(id) ON DELETE CASCADE|true|false|false",
		"workspace_agent_task_operations.workspace_agent_task_operatio_bot_id_operation_idempotency_fkey": "FOREIGN KEY (bot_id, operation, idempotency_key) REFERENCES workspace_agent_bot_idempotency(bot_id, operation, idempotency_key) ON DELETE CASCADE|true|false|false",
		"workspace_agent_task_operations.workspace_agent_task_operations_pkey":                            "PRIMARY KEY (task_id, operation, idempotency_key)|true|false|false",
		"workspace_agent_task_operations.workspace_agent_task_operations_task_id_fkey":                    "FOREIGN KEY (task_id) REFERENCES workspace_agent_tasks(id) ON DELETE CASCADE|true|false|false",
	}
	indexes := map[string]string{
		"workspace_agent_message_origins.workspace_agent_message_origins_pkey":     "btree|true|true|true|||message_id",
		"workspace_agent_message_origins.workspace_agent_message_origins_task_idx": "btree|false|true|true|||task_id",
		"workspace_agent_tasks.workspace_agent_tasks_bot_id_event_id_key":          "btree|true|true|true|||bot_id,event_id",
		"workspace_agent_tasks.workspace_agent_tasks_expiry_idx":                   "btree|false|true|true|||expires_at",
		"workspace_agent_tasks.workspace_agent_tasks_pkey":                         "btree|true|true|true|||id",
		"workspace_agent_tasks.workspace_agent_tasks_root_idx":                     "btree|false|true|true|||root_task_id",
		"workspace_agent_upload_origins.workspace_agent_upload_origins_pkey":       "btree|true|true|true|||upload_id",
		"workspace_agent_upload_origins.workspace_agent_upload_origins_task_idx":   "btree|false|true|true|||task_id",
		"workspace_agent_task_operations.workspace_agent_task_operations_pkey":     "btree|true|true|true|||task_id,operation,idempotency_key",
	}
	for _, check := range []struct {
		query    string
		expected map[string]string
	}{
		{compatibleAgentColumnsSQL, columns},
		{compatibleAgentConstraintsSQL, constraints},
		{compatibleAgentIndexesSQL, indexes},
	} {
		if err := inspectAgentMetadata(ctx, queryer, check.query, check.expected); err != nil {
			return err
		}
	}
	return nil
}

func inspectAgentMetadata(ctx context.Context, queryer Queryer, query string, expected map[string]string) error {
	incompatible := errors.Join(ErrSchemaCompatibility, ErrCompatibleMigrationSchema)
	var mismatch bool
	err := readCompatibilityRows(ctx, queryer, query, "compatible agent migration metadata", func(rows Rows) error {
		for rows.Next() {
			var key, definition string
			if err := rows.Scan(&key, &definition); err != nil {
				return err
			}
			want, exists := expected[key]
			if !exists || strings.Join(strings.Fields(definition), " ") != want {
				mismatch = true
			}
			delete(expected, key)
		}
		return nil
	})
	if err != nil {
		return err
	}
	if mismatch || len(expected) != 0 {
		return incompatible
	}
	return nil
}
