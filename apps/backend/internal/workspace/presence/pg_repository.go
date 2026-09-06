package presence

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/presence/internal/presencequeries"
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
	connectionID, err := presencequeries.New(r.pool).Register(ctx, presencequeries.RegisterParams{
		SpaceID: record.Lease.SpaceID, UserID: record.Lease.UserID, ConnectionID: record.Lease.ConnectionID,
		LeaseUntil: pgTime(record.Lease.LeaseUntil), CreatedAt: pgTime(record.CreatedAt),
	})
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
	count, err := presencequeries.New(r.pool).Renew(ctx, presencequeries.RenewParams{
		SpaceID: record.Lease.SpaceID, UserID: record.Lease.UserID, ConnectionID: record.Lease.ConnectionID,
		LeaseUntil: pgTime(record.Lease.LeaseUntil), NowAt: pgTime(record.Now),
	})
	if err != nil {
		return false, fmt.Errorf("renew workspace presence lease: %w", err)
	}
	return count == 1, nil
}

func (r *PGRepository) Delete(ctx context.Context, lease Lease) (bool, error) {
	if r == nil || r.pool == nil {
		return false, errors.New("workspace presence postgres pool is required")
	}
	if lease.SpaceID == "" || lease.UserID == "" || lease.ConnectionID == "" {
		return false, ErrInvalidInput
	}
	count, err := presencequeries.New(r.pool).Delete(ctx, presencequeries.DeleteParams{
		SpaceID: lease.SpaceID, UserID: lease.UserID, ConnectionID: lease.ConnectionID,
	})
	if err != nil {
		return false, fmt.Errorf("delete workspace presence lease: %w", err)
	}
	return count == 1, nil
}

func (r *PGRepository) IsOnline(ctx context.Context, query OnlineQuery) (bool, error) {
	if r == nil || r.pool == nil {
		return false, errors.New("workspace presence postgres pool is required")
	}
	if query.SpaceID == "" || query.UserID == "" || query.Now.IsZero() {
		return false, ErrInvalidInput
	}
	online, err := presencequeries.New(r.pool).IsOnline(ctx, presencequeries.IsOnlineParams{
		SpaceID: query.SpaceID, UserID: query.UserID, NowAt: pgTime(query.Now),
	})
	if err != nil {
		return false, fmt.Errorf("lookup workspace presence: %w", err)
	}
	return online, nil
}

func (r *PGRepository) SweepExpired(ctx context.Context, input SweepInput) (int, error) {
	if r == nil || r.pool == nil {
		return 0, errors.New("workspace presence postgres pool is required")
	}
	if input.Now.IsZero() || input.Limit <= 0 || input.Limit > MaximumSweepBatch {
		return 0, ErrInvalidInput
	}
	count, err := presencequeries.New(r.pool).SweepExpired(ctx, presencequeries.SweepExpiredParams{
		NowAt: pgTime(input.Now), BatchSize: int32(input.Limit),
	})
	if err != nil {
		return 0, fmt.Errorf("sweep workspace presence leases: %w", err)
	}
	return int(count), nil
}

func pgTime(value time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: value.UTC(), Valid: !value.IsZero()}
}
