package files

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

func (r *PGRepository) LookupActiveAgentBot(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("read file bot identity", errors.New("database is required"))
	}
	return lookupActiveAgentBot(ctx, r.pool, spaceID, userID, false)
}

func (t *pgTx) LookupActiveAgentBot(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	return lookupActiveAgentBot(ctx, t.tx, spaceID, userID, true)
}

func lookupActiveAgentBot(ctx context.Context, queryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, spaceID, userID string, lock bool) (*auth.Actor, error) {
	query := `SELECT u.id,u.github_login,u.display_name,u.kind,sm.role,sm.joined_at
		FROM users u JOIN space_members sm ON sm.user_id=u.id
		JOIN workspace_agent_bots b ON b.bot_user_id=u.id AND b.space_id=sm.space_id
		WHERE u.id=$1 AND sm.space_id=$2 AND sm.removed_at IS NULL
		AND u.kind='bot' AND b.status='active'`
	if lock {
		query += ` FOR SHARE OF u,sm,b`
	}
	var actor auth.Actor
	if err := queryer.QueryRow(ctx, query, userID, spaceID).Scan(&actor.ID, &actor.GitHubLogin, &actor.DisplayName, &actor.Kind, &actor.Role, &actor.JoinedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, internalError("read file bot identity", err)
	}
	return &actor, nil
}
