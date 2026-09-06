package presence

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PGRepository is the PostgreSQL adapter for short-lived Workspace presence
// leases. It has no generic query surface so callers cannot bypass the active
// human-membership and expiry predicates.
type PGRepository struct {
	pool *pgxpool.Pool
}

func NewPGRepository(pool *pgxpool.Pool) *PGRepository {
	return &PGRepository{pool: pool}
}

var _ Repository = (*PGRepository)(nil)

func (r *PGRepository) Register(ctx context.Context, record RegisterRecord) error {
	if r == nil || r.pool == nil {
		return errors.New("workspace presence postgres pool is required")
	}
	if record.Lease.SpaceID == "" || record.Lease.UserID == "" || record.Lease.ConnectionID == "" || record.Lease.LeaseUntil.IsZero() || record.CreatedAt.IsZero() {
		return ErrInvalidInput
	}
	var connectionID string
	err := r.pool.QueryRow(ctx, `
		INSERT INTO workspace_presence_leases
		  (space_id, user_id, connection_id, lease_until, created_at, updated_at)
		SELECT $1, u.id, $3, $4, $5, $5
		FROM users u
		INNER JOIN space_members sm
		  ON sm.space_id = $1
		 AND sm.user_id = u.id
		 AND sm.removed_at IS NULL
		WHERE u.id = $2 AND u.kind = 'human'
		RETURNING connection_id
	`, record.Lease.SpaceID, record.Lease.UserID, record.Lease.ConnectionID, record.Lease.LeaseUntil.UTC(), record.CreatedAt.UTC()).Scan(&connectionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotAuthorized
	}
	if err != nil {
		return fmt.Errorf("register workspace presence lease: %w", err)
	}
	if connectionID != record.Lease.ConnectionID {
		return errors.New("register workspace presence lease returned an unexpected id")
	}
	return nil
}

func (r *PGRepository) Renew(ctx context.Context, record RenewRecord) (bool, error) {
	if r == nil || r.pool == nil {
		return false, errors.New("workspace presence postgres pool is required")
	}
	if record.Lease.SpaceID == "" || record.Lease.UserID == "" || record.Lease.ConnectionID == "" || record.Lease.LeaseUntil.IsZero() || record.Now.IsZero() {
		return false, ErrInvalidInput
	}
	result, err := r.pool.Exec(ctx, `
		UPDATE workspace_presence_leases
		SET lease_until = $1, updated_at = $2
		WHERE space_id = $3
		  AND user_id = $4
		  AND connection_id = $5
		  AND lease_until > $2
		  AND EXISTS (
			SELECT 1
			FROM users u
			INNER JOIN space_members sm
			  ON sm.space_id = workspace_presence_leases.space_id
			 AND sm.user_id = workspace_presence_leases.user_id
			 AND sm.removed_at IS NULL
			WHERE u.id = workspace_presence_leases.user_id
			  AND u.kind = 'human'
		)
	`, record.Lease.LeaseUntil.UTC(), record.Now.UTC(), record.Lease.SpaceID, record.Lease.UserID, record.Lease.ConnectionID)
	if err != nil {
		return false, fmt.Errorf("renew workspace presence lease: %w", err)
	}
	return result.RowsAffected() == 1, nil
}

func (r *PGRepository) Delete(ctx context.Context, lease Lease) (bool, error) {
	if r == nil || r.pool == nil {
		return false, errors.New("workspace presence postgres pool is required")
	}
	if lease.SpaceID == "" || lease.UserID == "" || lease.ConnectionID == "" {
		return false, ErrInvalidInput
	}
	result, err := r.pool.Exec(ctx, `
		DELETE FROM workspace_presence_leases
		WHERE space_id = $1 AND user_id = $2 AND connection_id = $3
	`, lease.SpaceID, lease.UserID, lease.ConnectionID)
	if err != nil {
		return false, fmt.Errorf("delete workspace presence lease: %w", err)
	}
	return result.RowsAffected() == 1, nil
}

func (r *PGRepository) IsOnline(ctx context.Context, query OnlineQuery) (bool, error) {
	if r == nil || r.pool == nil {
		return false, errors.New("workspace presence postgres pool is required")
	}
	if query.SpaceID == "" || query.UserID == "" || query.Now.IsZero() {
		return false, ErrInvalidInput
	}
	var online bool
	err := r.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM workspace_presence_leases p
			INNER JOIN users u
			  ON u.id = p.user_id AND u.kind = 'human'
			INNER JOIN space_members sm
			  ON sm.space_id = p.space_id
			 AND sm.user_id = p.user_id
			 AND sm.removed_at IS NULL
			WHERE p.space_id = $1
			  AND p.user_id = $2
			  AND p.lease_until > $3
		)
	`, query.SpaceID, query.UserID, query.Now.UTC()).Scan(&online)
	if err != nil {
		return false, fmt.Errorf("lookup workspace presence: %w", err)
	}
	return online, nil
}

func (r *PGRepository) SweepExpired(ctx context.Context, input SweepInput) (int, error) {
	if r == nil || r.pool == nil {
		return 0, errors.New("workspace presence postgres pool is required")
	}
	if input.Now.IsZero() || input.Limit <= 0 {
		return 0, ErrInvalidInput
	}
	result, err := r.pool.Exec(ctx, `
		WITH expired AS (
			SELECT space_id, user_id, connection_id
			FROM workspace_presence_leases
			WHERE lease_until <= $1
			ORDER BY lease_until, space_id, user_id, connection_id
			LIMIT $2
			FOR UPDATE SKIP LOCKED
		)
		DELETE FROM workspace_presence_leases p
		USING expired
		WHERE p.space_id = expired.space_id
		  AND p.user_id = expired.user_id
		  AND p.connection_id = expired.connection_id
	`, input.Now.UTC(), input.Limit)
	if err != nil {
		return 0, fmt.Errorf("sweep workspace presence leases: %w", err)
	}
	return int(result.RowsAffected()), nil
}
