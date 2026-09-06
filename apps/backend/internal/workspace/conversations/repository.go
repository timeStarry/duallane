package conversations

import (
	"context"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	workspaceMessages "github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

// ReadRepository is the intentionally small storage seam used by the
// conversation application service. Methods that accept actorID still scope
// their result in storage; callers must not treat a prior route check as
// authorization.
type ReadRepository interface {
	LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error)
	ListConversationRecords(ctx context.Context, spaceID, actorID string) ([]ConversationRecord, error)
	GetVisibleConversationRecord(ctx context.Context, spaceID, actorID, conversationID string) (*ConversationRecord, error)
	FindConversation(ctx context.Context, spaceID, conversationID string) (*ConversationRecord, error)
	FindDirectConversation(ctx context.Context, spaceID, directKey string) (*ConversationRecord, error)
	ListConversationMembers(ctx context.Context, spaceID, conversationID, viewerID string) ([]MemberRecord, error)
	ListLatestMessages(ctx context.Context, spaceID, conversationID, viewerID string, limit int) ([]MessageRecord, error)
	ListMessageAttachments(ctx context.Context, spaceID string, messageIDs []string) (map[string][]workspaceMessages.AttachmentRecord, error)
	FindMember(ctx context.Context, spaceID, userID string) (*MemberRecord, error)
	MemberVisible(ctx context.Context, spaceID, viewerID, visibleUserID string) (bool, error)
	SharesActiveGroup(ctx context.Context, spaceID, actorID, targetUserID string) (bool, error)
	ConversationMemberActive(ctx context.Context, spaceID, conversationID, userID string) (bool, error)
	CountActiveConversationMembers(ctx context.Context, spaceID, conversationID string) (int, error)
	FindMessageForPin(ctx context.Context, spaceID, conversationID, messageID string) (*MessageRecord, error)
	FindPin(ctx context.Context, spaceID, conversationID, messageID, viewerID string) (*PinRecord, error)
	ListPins(ctx context.Context, spaceID, conversationID, viewerID string, limit int) ([]PinRecord, error)
}

// Repository adds one explicit transaction boundary to the read seam. The
// callback must return nil after a deliberate rejection has been audited; a
// returned error rolls the transaction back.
type Repository interface {
	ReadRepository
	WithTx(ctx context.Context, fn func(Tx) error) error
}

// Tx is the domain-owned PostgreSQL transaction seam. It embeds the read
// operations so a successful mutation can project its result before commit,
// while all state, event, and audit writes remain on the same transaction.
type Tx interface {
	ReadRepository
	Lock(ctx context.Context, key string) error
	CreateConversation(ctx context.Context, record CreateConversationRecord) error
	UpsertConversationMember(ctx context.Context, spaceID, conversationID, userID string, joinedAt time.Time) (bool, error)
	RemoveConversationMember(ctx context.Context, spaceID, conversationID, userID string, removedAt time.Time) (bool, error)
	UpdateGroup(ctx context.Context, spaceID, conversationID, title string, avatarEmoji *string) error
	CreateSystemMessage(ctx context.Context, record SystemMessageInsert, retentionCount int64) (*MessageRecord, error)
	MarkConversationRead(ctx context.Context, spaceID, conversationID, userID string, now time.Time) (ReadMarker, error)
	UpdateNotificationLevel(ctx context.Context, spaceID, conversationID, userID, level string) error
	AddPin(ctx context.Context, spaceID, conversationID, messageID, userID string, createdAt time.Time) (bool, error)
	RemovePin(ctx context.Context, spaceID, conversationID, messageID string) (*PinRecord, bool, error)
	WriteEvent(ctx context.Context, input EventInput) error
	WriteAudit(ctx context.Context, input AuditInput) error
}

var _ Repository = (*PGRepository)(nil)
