package invites

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type PGRepository struct {
	pool      *pgxpool.Pool
	idFactory IDFactory
}

func NewPGRepository(pool *pgxpool.Pool, idFactories ...IDFactory) *PGRepository {
	idFactory := IDFactory(func() (string, error) {
		id, err := uuid.NewRandom()
		if err != nil {
			return "", err
		}
		return id.String(), nil
	})
	if len(idFactories) > 0 && idFactories[0] != nil {
		idFactory = idFactories[0]
	}
	return &PGRepository{pool: pool, idFactory: idFactory}
}

func (repository *PGRepository) WithTx(ctx context.Context, callback func(Tx) error) error {
	if repository == nil || repository.pool == nil {
		return internalError("begin invite transaction", errors.New("workspace postgres pool is required"))
	}
	if callback == nil {
		return internalError("begin invite transaction", errors.New("transaction callback is required"))
	}
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return internalError("begin invite transaction", err)
	}
	committed := false
	defer func() {
		if !committed {
			rollbackCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = tx.Rollback(rollbackCtx)
		}
	}()
	adapter := &pgTx{tx: tx, idFactory: repository.idFactory}
	if err := callback(adapter); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return internalError("commit invite transaction", err)
	}
	committed = true
	return nil
}

type pgTx struct {
	tx        pgx.Tx
	idFactory IDFactory
}

func (tx *pgTx) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	if tx == nil || tx.tx == nil {
		return nil, errors.New("invite transaction is required")
	}
	var actor auth.Actor
	var githubID, email, nickname, avatarURL *string
	err := tx.tx.QueryRow(ctx, `
		SELECT u.id, u.github_id, u.github_login, u.email, u.display_name, u.nickname,
			u.avatar_url, u.search_discoverable, u.kind, sm.role, sm.joined_at
		FROM users u
		INNER JOIN space_members sm ON sm.user_id = u.id AND sm.space_id = $2 AND sm.removed_at IS NULL
		WHERE u.id = $1
	`, userID, spaceID).Scan(
		&actor.ID, &githubID, &actor.GitHubLogin, &email, &actor.DisplayName, &nickname,
		&avatarURL, &actor.SearchDiscoverable, &actor.Kind, &actor.Role, &actor.JoinedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	actor.GitHubID = nullableString(githubID)
	actor.Email = nullableString(email)
	actor.Nickname = nullableString(nickname)
	actor.AvatarURL = nullableString(avatarURL)
	return &actor, nil
}

func (tx *pgTx) FindInviteForUpdate(ctx context.Context, spaceID, inviteID string) (*InviteRecord, error) {
	if tx == nil || tx.tx == nil {
		return nil, errors.New("invite transaction is required")
	}
	var record InviteRecord
	err := tx.tx.QueryRow(ctx, `
		SELECT id, space_id, code_hash, code_preview, default_role, created_by,
			max_uses, uses, expires_at, revoked_at, created_at
		FROM invites
		WHERE id = $1 AND space_id = $2
		FOR UPDATE
	`, strings.TrimSpace(inviteID), spaceID).Scan(
		&record.ID, &record.SpaceID, &record.CodeHash, &record.CodePreview, &record.DefaultRole,
		&record.CreatedBy, &record.MaxUses, &record.Uses, &record.ExpiresAt, &record.RevokedAt, &record.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

func (tx *pgTx) InsertInvite(ctx context.Context, record InviteRecord) error {
	_, err := tx.tx.Exec(ctx, `
		INSERT INTO invites (
			id, space_id, code_hash, code_preview, default_role, created_by,
			max_uses, uses, expires_at, revoked_at, created_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, NULL, $9)
	`, record.ID, record.SpaceID, record.CodeHash, record.CodePreview, record.DefaultRole,
		record.CreatedBy, record.MaxUses, record.ExpiresAt, record.CreatedAt.UTC())
	return err
}

func (tx *pgTx) RevokeInvite(ctx context.Context, spaceID, inviteID string, revokedAt time.Time) (bool, error) {
	result, err := tx.tx.Exec(ctx, `
		UPDATE invites SET revoked_at = $3
		WHERE id = $1 AND space_id = $2 AND revoked_at IS NULL
	`, inviteID, spaceID, revokedAt.UTC())
	if err != nil {
		return false, err
	}
	return result.RowsAffected() == 1, nil
}

func (tx *pgTx) WriteAudit(ctx context.Context, input AuditInput) error {
	id, err := tx.newID()
	if err != nil {
		return err
	}
	_, err = tx.tx.Exec(ctx, `
		INSERT INTO audit_logs (
			id, space_id, actor_user_id, actor_github_login, action, target_type,
			target_id, result, reason, ip_address, user_agent, request_id, created_at
		) VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), $5, $6,
			NULLIF($7, ''), $8, NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''), $13)
	`, id, input.SpaceID, input.ActorUserID, input.ActorGitHubLogin, input.Action, input.TargetType,
		input.TargetID, input.Result, input.Reason, input.IPAddress, input.UserAgent, input.RequestID, input.CreatedAt.UTC())
	return err
}

func (tx *pgTx) newID() (string, error) {
	if tx == nil || tx.idFactory == nil {
		return "", errors.New("invite audit id factory is required")
	}
	id, err := tx.idFactory()
	if err != nil {
		return "", err
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return "", errors.New("invite audit id factory returned an empty id")
	}
	return id, nil
}

func nullableString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

var _ Repository = (*PGRepository)(nil)
var _ Tx = (*pgTx)(nil)
