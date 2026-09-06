package avatars

import (
	"context"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

// ReadRepository is intentionally limited to the reads required by avatar
// authorization and object lifecycle. Implementations must re-check active
// membership rather than trusting a transport-provided role.
type ReadRepository interface {
	LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error)
	GetCurrentAvatar(ctx context.Context, spaceID, userID string) (*AvatarRecord, error)
	FindVisibleAvatar(ctx context.Context, spaceID, viewerID, userID, version string) (*AvatarRecord, error)
	StorageObject(ctx context.Context, objectID string) (*StorageObjectRecord, error)
	StorageObjectReferenceCount(ctx context.Context, objectID string) (int64, error)
}

type Repository interface {
	ReadRepository
	WithTx(ctx context.Context, fn func(Tx) error) error
}

type Tx interface {
	LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error)
	GetCurrentAvatarForUpdate(ctx context.Context, spaceID, userID string) (*AvatarRecord, error)
	Lock(ctx context.Context, key string) error
	EnsureStorageObjectAndBind(ctx context.Context, spaceID, userID string, object StorageObjectRecord) error
	UpdateAvatar(ctx context.Context, spaceID, userID, storageKey, version, avatarURL, storageObjectID string, updatedAt time.Time) (bool, error)
	ClearAvatar(ctx context.Context, spaceID, userID string, updatedAt time.Time) (bool, error)
	PrepareStorageObjectCleanup(ctx context.Context, objectID string, fallback StorageObjectRecord) (StorageCleanup, error)
	MarkStorageObjectDeleted(ctx context.Context, objectID string, at time.Time) error
	WriteEvent(ctx context.Context, input EventInput) error
	WriteAudit(ctx context.Context, input AuditInput) error
}

var _ Repository = (*PGRepository)(nil)
