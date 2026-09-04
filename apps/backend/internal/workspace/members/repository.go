package members

import (
	"context"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

// ReadRepository is the deliberately narrow storage boundary for member
// operations. Visibility is evaluated by storage against active memberships;
// callers must not turn an unscoped user lookup into authorization.
type ReadRepository interface {
	LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error)
	ListMemberRecords(ctx context.Context, spaceID, viewerID string) ([]MemberRecord, error)
	FindMemberRecord(ctx context.Context, spaceID, viewerID, userID string) (*MemberRecord, error)
	GetVisibilityRule(ctx context.Context, spaceID, viewerID string) (VisibilityRule, error)
	CountActiveOwners(ctx context.Context, spaceID string) (int, error)
}

// Repository adds one transaction boundary. Rejection callbacks must write a
// content-free audit and return nil so that the audit commits; other errors
// roll state and evidence back together.
type Repository interface {
	ReadRepository
	WithTx(ctx context.Context, fn func(Tx) error) error
}

type Tx interface {
	ReadRepository
	Lock(ctx context.Context, key string) error
	UpdateOwnProfile(ctx context.Context, spaceID, userID string, nicknameSet bool, nickname *string, discoverableSet bool, discoverable *bool, recallReasonSet bool, recallReason *string) error
	UpsertRemark(ctx context.Context, ownerUserID, targetUserID, remark string, updatedAt time.Time) error
	DeleteRemark(ctx context.Context, ownerUserID, targetUserID string) error
	ReplaceVisibilityGrants(ctx context.Context, spaceID, viewerUserID, createdBy string, visibleUserIDs []string, createdAt time.Time) error
	UpdateMemberRole(ctx context.Context, spaceID, userID, role string) error
	RemoveMember(ctx context.Context, spaceID, userID string, removedAt time.Time) (bool, error)
	RevokeUserConversationMemberships(ctx context.Context, userID string, removedAt time.Time) error
	RevokeUserSessions(ctx context.Context, userID string, revokedAt time.Time) error
	WriteEvent(ctx context.Context, input EventInput) error
	WriteAudit(ctx context.Context, input AuditInput) error
}

var _ Repository = (*PGRepository)(nil)
