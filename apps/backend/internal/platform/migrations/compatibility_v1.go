package migrations

import (
	"context"
	"errors"
	"strings"
)

const compatibleV1ColumnsSQL = `SELECT table_name || '.' || column_name,
  data_type || '|' || is_nullable
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND (
    table_name IN ('user_devices', 'qr_login_sessions', 'user_preferences', 'bot_commands', 'bot_webhooks', 'space_policies')
    OR (table_name = 'conversation_members' AND column_name = 'role')
    OR (table_name = 'messages' AND column_name IN ('thread_root_id', 'also_send_to_channel', 'thread_title', 'forwarded_from_json'))
    OR (table_name = 'attachments' AND column_name IN ('width', 'height', 'duration_ms', 'thumb_hash', 'waveform_json', 'source_message_id'))
  )
ORDER BY table_name, column_name`

const compatibleV1ConstraintsSQL = `SELECT relation.relname || '.' || constraint_row.conname,
  constraint_row.contype::text || '|' || constraint_row.convalidated::text
FROM pg_catalog.pg_constraint AS constraint_row
JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_row.conrelid
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = current_schema() AND relation.relkind = 'r'
  AND (
    (relation.relname = 'user_devices' AND constraint_row.conname = 'user_devices_pkey')
    OR (relation.relname = 'qr_login_sessions' AND constraint_row.conname = 'qr_login_sessions_pkey')
    OR (relation.relname = 'user_preferences' AND constraint_row.conname = 'user_preferences_pkey')
    OR (relation.relname = 'bot_commands' AND constraint_row.conname = 'bot_commands_pkey')
    OR (relation.relname = 'bot_webhooks' AND constraint_row.conname = 'bot_webhooks_pkey')
    OR (relation.relname = 'space_policies' AND constraint_row.conname = 'space_policies_pkey')
    OR (relation.relname = 'conversations' AND constraint_row.conname = 'conversations_type_check')
    OR (relation.relname = 'workspace_agent_bots' AND constraint_row.conname = 'workspace_agent_bots_trigger_policy_check')
    OR (relation.relname = 'workspace_agent_bot_settings' AND constraint_row.conname = 'workspace_agent_bot_settings_trigger_policy_check')
    OR (relation.relname = 'conversation_pin_counters' AND constraint_row.conname = 'conversation_pin_counters_pin_count_check')
  )
ORDER BY relation.relname, constraint_row.conname`

func inspectReviewed036Schema(ctx context.Context, queryer Queryer) error {
	columns := map[string]string{
		"attachments.duration_ms":                    "integer|YES",
		"attachments.height":                         "integer|YES",
		"attachments.source_message_id":              "text|YES",
		"attachments.thumb_hash":                     "text|YES",
		"attachments.waveform_json":                  "text|YES",
		"attachments.width":                          "integer|YES",
		"bot_commands.bot_id":                        "text|NO",
		"bot_commands.command":                       "text|NO",
		"bot_commands.created_at":                    "timestamp with time zone|NO",
		"bot_commands.description":                   "text|NO",
		"bot_commands.id":                            "text|NO",
		"bot_commands.scope":                         "text|NO",
		"bot_webhooks.bot_id":                        "text|NO",
		"bot_webhooks.enabled":                       "boolean|NO",
		"bot_webhooks.last_error":                    "text|YES",
		"bot_webhooks.last_status":                   "integer|YES",
		"bot_webhooks.secret_hash":                   "text|NO",
		"bot_webhooks.updated_at":                    "timestamp with time zone|NO",
		"bot_webhooks.url":                           "text|NO",
		"conversation_members.role":                  "text|NO",
		"messages.also_send_to_channel":              "boolean|NO",
		"messages.forwarded_from_json":               "text|YES",
		"messages.thread_root_id":                    "text|YES",
		"messages.thread_title":                      "text|YES",
		"qr_login_sessions.approved_at":              "timestamp with time zone|YES",
		"qr_login_sessions.challenge":                "text|NO",
		"qr_login_sessions.consumed_at":              "timestamp with time zone|YES",
		"qr_login_sessions.created_at":               "timestamp with time zone|NO",
		"qr_login_sessions.device_name":              "text|YES",
		"qr_login_sessions.expires_at":               "timestamp with time zone|NO",
		"qr_login_sessions.id":                       "text|NO",
		"qr_login_sessions.platform":                 "text|YES",
		"qr_login_sessions.status":                   "text|NO",
		"qr_login_sessions.user_id":                  "text|YES",
		"space_policies.daily_quota_bytes":           "bigint|NO",
		"space_policies.message_retention_count":     "integer|NO",
		"space_policies.space_id":                    "text|NO",
		"space_policies.updated_at":                  "timestamp with time zone|NO",
		"space_policies.updated_by":                  "text|YES",
		"user_devices.app_version":                   "text|NO",
		"user_devices.created_at":                    "timestamp with time zone|NO",
		"user_devices.device_name":                   "text|NO",
		"user_devices.id":                            "text|NO",
		"user_devices.last_active_at":                "timestamp with time zone|NO",
		"user_devices.platform":                      "text|NO",
		"user_devices.push_provider":                 "text|YES",
		"user_devices.push_token":                    "text|YES",
		"user_devices.revoked_at":                    "timestamp with time zone|YES",
		"user_devices.token_hash":                    "text|YES",
		"user_devices.user_id":                       "text|NO",
		"user_preferences.prefs_json":                "text|NO",
		"user_preferences.updated_at":                "timestamp with time zone|NO",
		"user_preferences.user_id":                   "text|NO",
	}
	constraints := map[string]string{
		"bot_commands.bot_commands_pkey":                                                  "p|true",
		"bot_webhooks.bot_webhooks_pkey":                                                  "p|true",
		"conversation_pin_counters.conversation_pin_counters_pin_count_check":             "c|true",
		"conversations.conversations_type_check":                                          "c|true",
		"qr_login_sessions.qr_login_sessions_pkey":                                        "p|true",
		"space_policies.space_policies_pkey":                                              "p|true",
		"user_devices.user_devices_pkey":                                                  "p|true",
		"user_preferences.user_preferences_pkey":                                          "p|true",
		"workspace_agent_bot_settings.workspace_agent_bot_settings_trigger_policy_check":  "c|true",
		"workspace_agent_bots.workspace_agent_bots_trigger_policy_check":                  "c|true",
	}
	for _, check := range []struct {
		query    string
		expected map[string]string
	}{
		{compatibleV1ColumnsSQL, columns},
		{compatibleV1ConstraintsSQL, constraints},
	} {
		if err := inspectV1Metadata(ctx, queryer, check.query, check.expected); err != nil {
			return err
		}
	}
	return nil
}

func inspectV1Metadata(ctx context.Context, queryer Queryer, query string, expected map[string]string) error {
	incompatible := errors.Join(ErrSchemaCompatibility, ErrCompatibleMigrationSchema)
	var mismatch bool
	err := readCompatibilityRows(ctx, queryer, query, "compatible v1 migration metadata", func(rows Rows) error {
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
