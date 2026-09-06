package messages

import (
	"context"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messagejobs"
)

// ReadRepository is the narrow storage seam owned by the message domain.
// Actor, membership, mention and attachment reads are intentionally present so
// the application service repeats authorization at the resource boundary.
type ReadRepository interface {
	LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error)
	GetConversation(ctx context.Context, spaceID, conversationID string) (*ConversationRecord, error)
	ConversationMemberActive(ctx context.Context, spaceID, conversationID, userID string) (bool, error)
	FindMessage(ctx context.Context, spaceID, conversationID, messageID string) (*MessageRecord, error)
	FindMessageByClientID(ctx context.Context, spaceID, conversationID, actorID, clientMessageID string) (*MessageRecord, error)
	MessageExists(ctx context.Context, spaceID, conversationID, messageID string) (bool, error)
	ListMessages(ctx context.Context, options ListOptions) ([]MessageRecord, error)
	ListAttachments(ctx context.Context, spaceID, viewerID string, messageIDs []string) (map[string][]AttachmentRecord, error)
	ListReactions(ctx context.Context, spaceID, viewerID string, messageIDs []string) (map[string][]ReactionGroup, error)
	ListHidden(ctx context.Context, spaceID, viewerID string, messageIDs []string) (map[string]bool, error)
	FindMentionMember(ctx context.Context, spaceID, conversationID, userID string) (*MentionMember, error)
	FindAttachment(ctx context.Context, spaceID, attachmentID string) (*AttachmentRecord, error)
}

// ViewerMessageLookup is an optional extension for adapters that can apply
// viewer-specific user remarks while loading one message. The core seam stays
// narrow so in-memory and future adapters need not implement remarks.
type ViewerMessageLookup interface {
	FindMessageForViewer(ctx context.Context, spaceID, conversationID, messageID, viewerID string) (*MessageRecord, error)
}

// MessageShareReader is an optional read-only extension. It is deliberately
// separate from ReadRepository and Tx so existing fakes and cross-domain
// writers (including Echo delivery) do not acquire a new mutation method.
// Implementations must scope results to message_emote_collection_shares rows;
// a caller-provided share ID is never sufficient to return metadata.
type MessageShareReader interface {
	ListMessageEmoteCollectionShares(ctx context.Context, spaceID, viewerID string, messageIDs []string) (map[string]map[string]EmoteCollectionShare, error)
}

// BuiltinEmoteSource resolves only the public image source for an imported
// built-in emote. The catalog remains owned by the emote domain; messages
// accepts this tiny read adapter so it does not import or duplicate catalog
// policy.
type BuiltinEmoteSource interface {
	ResolveBuiltinEmote(ctx context.Context, emoteKey string) (string, bool)
}

// RecallReasonLookup is optional so the auth package can remain compatible
// with its existing Actor shape while the message service still honors the
// current per-user recall copy when the column exists.
type RecallReasonLookup interface {
	LookupRecallReason(ctx context.Context, spaceID, userID string) (string, error)
}

// ReactionEmoteValidator is deliberately explicit. The message slice does not
// own the imported emote catalog; production wiring can provide its catalog
// validator, while tests can use a deterministic allow/deny implementation.
type ReactionEmoteValidator interface {
	IsVisibleReactionEmote(ctx context.Context, emoteKey string) (bool, error)
	IsKnownReactionEmote(ctx context.Context, emoteKey string) (bool, error)
}

// Repository adds one explicit transaction boundary. A callback that returns
// nil commits; application-level rejected operations write a content-free
// audit row and then return nil so the rejection evidence commits atomically.
type Repository interface {
	ReadRepository
	WithTx(ctx context.Context, fn func(Tx) error) error
}

// Tx embeds reads so each mutation can re-check current actor, membership and
// object authorization after taking its stable conversation lock.
type Tx interface {
	ReadRepository
	Lock(ctx context.Context, key string) error
	InsertMessage(ctx context.Context, record MessageInsert) (inserted bool, existing *MessageRecord, err error)
	LinkMessageAttachment(ctx context.Context, spaceID, messageID, attachmentID string) error
	LinkMessageCustomEmote(ctx context.Context, messageID, actorID, customEmoteID string) error
	LinkMessageEmoteCollectionShare(ctx context.Context, messageID, shareID string) error
	EnforceRetention(ctx context.Context, spaceID, conversationID string, retentionCount int64, now time.Time) error
	RecallMessage(ctx context.Context, spaceID, messageID string, expectedRevision int64, contentJSON []byte, plainText string, reason string, now time.Time) (bool, error)
	DeleteMessageReactions(ctx context.Context, spaceID, messageID string) error
	DeleteMessageCustomEmotes(ctx context.Context, spaceID, messageID string) error
	DeleteMessageEmoteCollectionShares(ctx context.Context, spaceID, messageID string) error
	DeleteMessagePins(ctx context.Context, spaceID, messageID string) error
	HideMessage(ctx context.Context, spaceID, messageID, userID string, now time.Time) (bool, error)
	UnhideMessage(ctx context.Context, spaceID, messageID, userID string) (bool, error)
	AddReaction(ctx context.Context, spaceID, messageID, userID, emoteKey string, now time.Time) (bool, error)
	RemoveReaction(ctx context.Context, spaceID, messageID, userID, emoteKey string, now time.Time) (bool, error)
	WriteEvent(ctx context.Context, input EventInput) (EventRecord, error)
	WriteAudit(ctx context.Context, input AuditInput) error
}

// MessageJobTx is implemented by production transaction adapters that can
// atomically add durable notification work to a successful message write.
type MessageJobTx interface {
	ScheduleMessageJobs(context.Context, messagejobs.Input) error
}

var _ Repository = (*PGRepository)(nil)
