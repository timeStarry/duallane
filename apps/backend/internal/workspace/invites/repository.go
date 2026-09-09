package invites

import (
	"context"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type RequestMeta = auth.RequestMeta

type Repository interface {
	WithTx(context.Context, func(Tx) error) error
}

type Tx interface {
	LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error)
	FindInviteForUpdate(ctx context.Context, spaceID, inviteID string) (*InviteRecord, error)
	InsertInvite(ctx context.Context, record InviteRecord) error
	RevokeInvite(ctx context.Context, spaceID, inviteID string, revokedAt time.Time) (bool, error)
	WriteAudit(ctx context.Context, input AuditInput) error
}
