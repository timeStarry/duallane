package overview

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type PGRepository struct {
	pool *pgxpool.Pool
}

func NewPGRepository(pool *pgxpool.Pool) *PGRepository {
	return &PGRepository{pool: pool}
}

func (repository *PGRepository) WithTx(ctx context.Context, callback func(Tx) error) error {
	if repository == nil || repository.pool == nil {
		return errors.New("workspace postgres pool is required")
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := callback(&pgTx{tx: tx}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type pgTx struct {
	tx pgx.Tx
}

func (tx *pgTx) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	var actor auth.Actor
	var githubID, email, nickname, avatarURL *string
	var discoverable *bool
	err := tx.tx.QueryRow(ctx, `SELECT u.id, u.github_id, u.github_login, u.email, u.display_name, u.nickname,
		u.avatar_url, u.search_discoverable, u.kind, sm.role, sm.joined_at
		FROM users u INNER JOIN space_members sm ON sm.user_id = u.id
		WHERE u.id = $1 AND sm.space_id = $2 AND sm.removed_at IS NULL`, userID, spaceID).Scan(
		&actor.ID, &githubID, &actor.GitHubLogin, &email, &actor.DisplayName, &nickname,
		&avatarURL, &discoverable, &actor.Kind, &actor.Role, &actor.JoinedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if githubID != nil {
		actor.GitHubID = *githubID
	}
	if email != nil {
		actor.Email = *email
	}
	if nickname != nil {
		actor.Nickname = *nickname
	}
	if avatarURL != nil {
		actor.AvatarURL = *avatarURL
	}
	if discoverable != nil {
		actor.SearchDiscoverable = *discoverable
	}
	return &actor, nil
}

func (tx *pgTx) ReadStatistics(ctx context.Context, spaceID string, dayStartedAt time.Time) (StatisticsRecord, error) {
	var record StatisticsRecord
	err := tx.tx.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM space_members WHERE space_id = $1),
		(SELECT COUNT(*) FROM conversations WHERE space_id = $1),
		(SELECT COUNT(*) FROM messages WHERE space_id = $1),
		(SELECT COUNT(*) FROM attachments WHERE space_id = $1 AND completed_at IS NOT NULL),
		(SELECT COALESCE(SUM(byte_size), 0) FROM attachments WHERE space_id = $1 AND completed_at IS NOT NULL),
		(SELECT COUNT(*) FROM space_members WHERE space_id = $1 AND joined_at >= $2),
		(SELECT COUNT(*) FROM conversations WHERE space_id = $1 AND created_at >= $2),
		(SELECT COUNT(*) FROM messages WHERE space_id = $1 AND created_at >= $2),
		(SELECT COUNT(*) FROM attachments WHERE space_id = $1 AND completed_at IS NOT NULL AND completed_at >= $2),
		(SELECT COALESCE(SUM(byte_size), 0) FROM attachments WHERE space_id = $1 AND completed_at IS NOT NULL AND completed_at >= $2)`,
		spaceID, dayStartedAt.UTC()).Scan(
		&record.Totals.Members, &record.Totals.Conversations, &record.Totals.Messages,
		&record.Totals.Files, &record.Totals.UploadedBytes, &record.Today.Members,
		&record.Today.Conversations, &record.Today.Messages, &record.Today.Files, &record.Today.UploadedBytes,
	)
	return record, err
}

func (tx *pgTx) WriteAudit(ctx context.Context, input AuditInput) error {
	_, err := tx.tx.Exec(ctx, `INSERT INTO audit_logs (
		id, space_id, actor_user_id, actor_github_login, action, target_type, target_id,
		result, reason, ip_address, user_agent, request_id, created_at
	) VALUES ($1, $2, $3, NULLIF($4, ''), $5, $6, $7, $8, $9, NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''), $13)`,
		input.ID, input.SpaceID, input.ActorUserID, input.ActorGitHubLogin, input.Action,
		input.TargetType, input.TargetID, input.Result, input.Reason, input.IPAddress,
		input.UserAgent, input.RequestID, input.CreatedAt.UTC())
	return err
}

var _ Repository = (*PGRepository)(nil)
