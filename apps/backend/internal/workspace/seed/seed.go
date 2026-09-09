// Package seed owns the idempotent Workspace records required by every fresh
// database. It intentionally runs only from the one-shot migration command.
package seed

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	DefaultSpaceID         = "spc_default"
	SeededOwnerID          = "usr_owner"
	SeededOwnerGitHubLogin = "timeStarry"
	SeededOwnerEmail       = "timestarry@qq.com"
	BeaconID               = "usr_system_beacon"
	BeaconGitHubLogin      = "__duallane_beacon__"
	EchoID                 = "usr_system_echo"
	EchoGitHubLogin        = "__duallane_echo__"
)

type beginner interface {
	BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error)
}

// Run preserves the seed contract previously owned by the Node migration
// command. The advisory lock and one transaction make concurrent invocations
// converge without exposing a partially seeded Workspace.
func Run(ctx context.Context, db beginner) error {
	if db == nil {
		return errors.New("workspace seed database is required")
	}
	tx, err := db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin workspace seed: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			rollbackCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = tx.Rollback(rollbackCtx)
		}
	}()

	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", "duallane:workspace-seed"); err != nil {
		return fmt.Errorf("lock workspace seed: %w", err)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	statements := []struct {
		name string
		sql  string
		args []any
	}{
		{
			name: "owner",
			sql: `INSERT INTO users (
				id, github_id, github_login, email, display_name, nickname, avatar_url, kind, created_at, last_login_at
			) VALUES ($1, NULL, $2, $3, $2, $2, NULL, 'human', $4, NULL)
			ON CONFLICT DO NOTHING`,
			args: []any{SeededOwnerID, SeededOwnerGitHubLogin, SeededOwnerEmail, now},
		},
		{
			name: "beacon identity",
			sql: `INSERT INTO users (
				id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at
			) VALUES ($1, NULL, $2, NULL, '信标', '/assets/beacon-avatar.png', 'bot', $3, NULL)
			ON CONFLICT (id) DO UPDATE SET
				github_id = NULL,
				github_login = EXCLUDED.github_login,
				email = NULL,
				display_name = EXCLUDED.display_name,
				avatar_url = EXCLUDED.avatar_url,
				kind = EXCLUDED.kind,
				last_login_at = NULL`,
			args: []any{BeaconID, BeaconGitHubLogin, now},
		},
		{
			name: "echo identity",
			sql: `INSERT INTO users (
				id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at
			) VALUES ($1, NULL, $2, NULL, '回声', '/assets/echo-avatar.svg', 'bot', $3, NULL)
			ON CONFLICT (id) DO UPDATE SET
				github_id = NULL,
				github_login = EXCLUDED.github_login,
				email = NULL,
				display_name = EXCLUDED.display_name,
				avatar_url = EXCLUDED.avatar_url,
				kind = EXCLUDED.kind,
				last_login_at = NULL`,
			args: []any{EchoID, EchoGitHubLogin, now},
		},
		{
			name: "default space",
			sql: `INSERT INTO spaces (id, name, slug, created_by, created_at)
			VALUES ($1, '默认空间', 'default', $2, $3)
			ON CONFLICT DO NOTHING`,
			args: []any{DefaultSpaceID, SeededOwnerID, now},
		},
		{
			name: "owner membership",
			sql: `INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
			VALUES ($1, $2, 'owner', $3, NULL)
			ON CONFLICT DO NOTHING`,
			args: []any{DefaultSpaceID, SeededOwnerID, now},
		},
		{
			name: "beacon membership",
			sql: `INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
			VALUES ($1, $2, 'member', $3, NULL)
			ON CONFLICT (space_id, user_id) DO UPDATE SET role = EXCLUDED.role, removed_at = NULL`,
			args: []any{DefaultSpaceID, BeaconID, now},
		},
		{
			name: "echo membership",
			sql: `INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
			VALUES ($1, $2, 'member', $3, NULL)
			ON CONFLICT (space_id, user_id) DO UPDATE SET role = EXCLUDED.role, removed_at = NULL`,
			args: []any{DefaultSpaceID, EchoID, now},
		},
		{
			name: "owner event",
			sql: `INSERT INTO workspace_events (
				id, space_id, seq, type, actor_user_id, conversation_id, target_type, target_id, payload_json, created_at
			) VALUES ('evt_seed_owner', $1, 1, 'workspace.member_joined', $2, NULL, 'user', $2, $3, $4)
			ON CONFLICT DO NOTHING`,
			args: []any{DefaultSpaceID, SeededOwnerID, `{"userId":"usr_owner","role":"owner"}`, now},
		},
		{
			name: "event cursor",
			sql: `INSERT INTO workspace_event_cursors (space_id, next_seq)
			SELECT $1, COALESCE(MAX(seq), 0) + 1 FROM workspace_events WHERE space_id = $1
			ON CONFLICT (space_id) DO UPDATE
			SET next_seq = GREATEST(workspace_event_cursors.next_seq, EXCLUDED.next_seq)`,
			args: []any{DefaultSpaceID},
		},
		{
			name: "owner audit",
			sql: `INSERT INTO audit_logs (
				id, space_id, actor_user_id, actor_github_login, action, target_type, target_id,
				result, reason, ip_address, user_agent, request_id, created_at
			) VALUES ('aud_seed_owner', $1, $2, $3, 'workspace.owner.seeded', 'workspace', $1,
				'success', 'development bootstrap', '127.0.0.1', 'duallane-seed', 'seed', $4)
			ON CONFLICT DO NOTHING`,
			args: []any{DefaultSpaceID, SeededOwnerID, SeededOwnerGitHubLogin, now},
		},
	}

	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement.sql, statement.args...); err != nil {
			return fmt.Errorf("seed workspace %s: %w", statement.name, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit workspace seed: %w", err)
	}
	committed = true
	return nil
}
