package migrations

import (
	"context"
	"errors"
	"strings"
)

// These fixed catalog queries never read token values or other application
// rows. The bridge accepts recorded 035 only when its tables, constraints and
// indexes have the reviewed shape, including the user/family delete behavior.
const compatibleMobileColumnsSQL = `SELECT table_name || '.' || column_name,
  data_type || '|' || is_nullable || '|' || COALESCE(column_default, '') || '|' ||
  is_identity || '|' || is_generated || '|' || COALESCE(domain_schema, '') || '.' || COALESCE(domain_name, '')
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name IN ('mobile_oauth_flows', 'mobile_session_families',
    'mobile_refresh_tokens', 'mobile_access_tokens', 'mobile_auth_rate_limits')
ORDER BY table_name, column_name`

const compatibleMobileConstraintsSQL = `SELECT relation.relname || '.' || constraint_row.conname,
  pg_get_constraintdef(constraint_row.oid, false) || '|' ||
  constraint_row.convalidated::text || '|' || constraint_row.condeferrable::text || '|' || constraint_row.condeferred::text
FROM pg_catalog.pg_constraint AS constraint_row
JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_row.conrelid
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = current_schema() AND relation.relkind = 'r'
  AND relation.relname IN ('mobile_oauth_flows', 'mobile_session_families',
    'mobile_refresh_tokens', 'mobile_access_tokens', 'mobile_auth_rate_limits')
ORDER BY relation.relname, constraint_row.conname`

const compatibleMobileIndexesSQL = `SELECT relation.relname || '.' || index_relation.relname,
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
  AND relation.relname IN ('mobile_oauth_flows', 'mobile_session_families',
    'mobile_refresh_tokens', 'mobile_access_tokens', 'mobile_auth_rate_limits')
ORDER BY relation.relname, index_relation.relname`

func inspectReviewed035Schema(ctx context.Context, queryer Queryer) error {
	columns := map[string]string{
		"mobile_oauth_flows.id":                "text|NO||NO|NEVER|.",
		"mobile_oauth_flows.challenge":         "text|NO||NO|NEVER|.",
		"mobile_oauth_flows.redirect_uri":      "text|NO||NO|NEVER|.",
		"mobile_oauth_flows.client_state":      "text|NO||NO|NEVER|.",
		"mobile_oauth_flows.expires_at":        "timestamp with time zone|NO||NO|NEVER|.",
		"mobile_oauth_flows.code_hash":         "text|YES||NO|NEVER|.",
		"mobile_oauth_flows.user_id":           "text|YES||NO|NEVER|.",
		"mobile_oauth_flows.consumed_at":       "timestamp with time zone|YES||NO|NEVER|.",
		"mobile_session_families.id":           "text|NO||NO|NEVER|.",
		"mobile_session_families.user_id":      "text|NO||NO|NEVER|.",
		"mobile_session_families.expires_at":   "timestamp with time zone|NO||NO|NEVER|.",
		"mobile_session_families.revoked_at":   "timestamp with time zone|YES||NO|NEVER|.",
		"mobile_refresh_tokens.token_hash":     "text|NO||NO|NEVER|.",
		"mobile_refresh_tokens.family_id":      "text|NO||NO|NEVER|.",
		"mobile_refresh_tokens.consumed_at":    "timestamp with time zone|YES||NO|NEVER|.",
		"mobile_access_tokens.token_hash":      "text|NO||NO|NEVER|.",
		"mobile_access_tokens.family_id":       "text|NO||NO|NEVER|.",
		"mobile_access_tokens.expires_at":      "timestamp with time zone|NO||NO|NEVER|.",
		"mobile_auth_rate_limits.subject_hash": "text|NO||NO|NEVER|.",
		"mobile_auth_rate_limits.window_start": "timestamp with time zone|NO||NO|NEVER|.",
		"mobile_auth_rate_limits.attempts":     "integer|NO||NO|NEVER|.",
	}
	constraints := map[string]string{
		"mobile_oauth_flows.mobile_oauth_flows_pkey":                   "PRIMARY KEY (id)|true|false|false",
		"mobile_oauth_flows.mobile_oauth_flows_code_hash_key":          "UNIQUE (code_hash)|true|false|false",
		"mobile_oauth_flows.mobile_oauth_flows_user_id_fkey":           "FOREIGN KEY (user_id) REFERENCES users(id)|true|false|false",
		"mobile_session_families.mobile_session_families_pkey":         "PRIMARY KEY (id)|true|false|false",
		"mobile_session_families.mobile_session_families_user_id_fkey": "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE|true|false|false",
		"mobile_refresh_tokens.mobile_refresh_tokens_pkey":             "PRIMARY KEY (token_hash)|true|false|false",
		"mobile_refresh_tokens.mobile_refresh_tokens_family_id_fkey":   "FOREIGN KEY (family_id) REFERENCES mobile_session_families(id) ON DELETE CASCADE|true|false|false",
		"mobile_access_tokens.mobile_access_tokens_pkey":               "PRIMARY KEY (token_hash)|true|false|false",
		"mobile_access_tokens.mobile_access_tokens_family_id_fkey":     "FOREIGN KEY (family_id) REFERENCES mobile_session_families(id) ON DELETE CASCADE|true|false|false",
		"mobile_auth_rate_limits.mobile_auth_rate_limits_pkey":         "PRIMARY KEY (subject_hash, window_start)|true|false|false",
	}
	indexes := map[string]string{
		"mobile_oauth_flows.mobile_oauth_flows_pkey":           "btree|true|true|true|||id",
		"mobile_oauth_flows.mobile_oauth_flows_code_hash_key":  "btree|true|true|true|||code_hash",
		"mobile_oauth_flows.mobile_oauth_expiry_idx":           "btree|false|true|true|||expires_at",
		"mobile_session_families.mobile_session_families_pkey": "btree|true|true|true|||id",
		"mobile_refresh_tokens.mobile_refresh_tokens_pkey":     "btree|true|true|true|||token_hash",
		"mobile_refresh_tokens.mobile_refresh_family_idx":      "btree|false|true|true|||family_id",
		"mobile_access_tokens.mobile_access_tokens_pkey":       "btree|true|true|true|||token_hash",
		"mobile_access_tokens.mobile_access_family_idx":        "btree|false|true|true|||family_id",
		"mobile_auth_rate_limits.mobile_auth_rate_limits_pkey": "btree|true|true|true|||subject_hash,window_start",
	}
	for _, check := range []struct {
		query    string
		expected map[string]string
	}{
		{compatibleMobileColumnsSQL, columns},
		{compatibleMobileConstraintsSQL, constraints},
		{compatibleMobileIndexesSQL, indexes},
	} {
		if err := inspectMobileMetadata(ctx, queryer, check.query, check.expected); err != nil {
			return err
		}
	}
	return nil
}

func inspectMobileMetadata(ctx context.Context, queryer Queryer, query string, expected map[string]string) error {
	incompatible := errors.Join(ErrSchemaCompatibility, ErrCompatibleMigrationSchema)
	var mismatch bool
	err := readCompatibilityRows(ctx, queryer, query, "compatible mobile migration metadata", func(rows Rows) error {
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
