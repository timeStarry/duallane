package botgateway

import (
	"context"
	"time"
)

// ReadRepository is deliberately gateway-shaped. It contains only current
// authorization state, safe metadata projections, and durable delivery state;
// message/card/file content writers remain owned by their respective domains.
type ReadRepository interface {
	LookupToken(ctx context.Context, tokenHash string, options TokenAuthOptions, now time.Time) (*Auth, error)
	ValidateToken(ctx context.Context, tokenID, botID, spaceID string, now time.Time) (*Auth, error)
	GetSettings(ctx context.Context, botID, spaceID string) (*Settings, error)
	GetConnection(ctx context.Context, botID, spaceID string) (*Connection, error)
	GetConversation(ctx context.Context, spaceID, conversationID string) (*Conversation, error)
	ConversationMemberActive(ctx context.Context, spaceID, conversationID, userID string) (bool, error)
	GetGroupPolicy(ctx context.Context, botID, spaceID, conversationID string) (*GroupPolicy, error)
	GetContextGrant(ctx context.Context, botID, spaceID, conversationID string) (*ContextGrant, error)
	ListContextMessages(ctx context.Context, spaceID, conversationID string, since time.Time, includeReplies, includeSystemEvents bool, limit int) ([]ContextMessageRecord, error)
	GetAttachment(ctx context.Context, spaceID, attachmentID string) (*AttachmentRecord, error)

	CurrentSequence(ctx context.Context, spaceID string) (int64, error)
	EarliestSequence(ctx context.Context, spaceID string) (int64, error)
	ListRecentEvents(ctx context.Context, spaceID string, limit int) ([]EventRecord, error)
	ListEventsAfter(ctx context.Context, spaceID string, afterSequence int64, limit int) ([]EventRecord, error)
	GetEvent(ctx context.Context, spaceID, eventID string) (*EventRecord, error)
	ListDeliveriesAfter(ctx context.Context, botID, spaceID string, afterSequence int64, now time.Time, limit int) ([]DeliveryRecord, error)
	EarliestDeliverySequence(ctx context.Context, botID, spaceID string, now time.Time) (int64, error)
	GetMessageTrigger(ctx context.Context, spaceID, conversationID, messageID string) (*MessageTrigger, error)
	GetSender(ctx context.Context, spaceID, conversationID, userID string) (*Sender, error)
	VisibilityMember(ctx context.Context, botID, spaceID, userID string) (bool, error)
	GetLimits(ctx context.Context, botID, spaceID string) (*Limits, error)
	CountRecentDeliveries(ctx context.Context, botID, spaceID string, since time.Time) (int, error)
	CountMemberDeliveries(ctx context.Context, botID, spaceID, actorUserID string, since time.Time) (int, error)
	CountPendingDeliveries(ctx context.Context, botID, spaceID string, now time.Time) (int, error)
}

// Repository adds one transaction boundary for idempotency and durable
// delivery transitions. Every mutation is expected to re-check current state
// through the Tx reads after entering the transaction.
type Repository interface {
	ReadRepository
	WithTx(ctx context.Context, fn func(Tx) error) error
}

type Tx interface {
	ReadRepository
	Lock(ctx context.Context, key string) error
	GetIdempotency(ctx context.Context, botID, operation, key string, now time.Time) (*IdempotencyRecord, error)
	InsertIdempotency(ctx context.Context, record IdempotencyRecordInput) (bool, error)
	ExpireDeliveries(ctx context.Context, botID, spaceID string, now time.Time) error
	ExpireDelivery(ctx context.Context, id string) error
	InsertDelivery(ctx context.Context, input DeliveryInsert) (bool, error)
	MarkDeliveryDelivered(ctx context.Context, id string, now time.Time) error
	AcknowledgeDelivery(ctx context.Context, botID, spaceID, eventID string, sequence int64, now time.Time) (bool, error)
	MarkProcessed(ctx context.Context, botID, spaceID string, now time.Time) error
	WriteAudit(ctx context.Context, input AuditInput) error
}

type IdempotencyRecordInput struct {
	ID           string
	BotID        string
	TokenID      string
	SpaceID      string
	Operation    string
	Key          string
	RequestHash  string
	ResponseJSON []byte
	CreatedAt    time.Time
	ExpiresAt    time.Time
}

type AuditInput struct {
	ID               string
	SpaceID          string
	ActorUserID      string
	ActorGitHubLogin string
	Action           string
	TargetType       string
	TargetID         string
	Result           string
	Reason           string
	RequestID        string
	IPAddress        string
	UserAgent        string
	CreatedAt        time.Time
}

type MessageWriter interface {
	CreateBotMessage(ctx context.Context, input MessageWriteRequest) (GatewayMessage, error)
}

// TransactionalMessageWriter is optional. When supplied, the adapter receives
// the same gateway transaction and can atomically write the message/event with
// the idempotency record. A plain MessageWriter remains useful for migration
// wiring, but its implementation must provide its own rollback semantics.
type TransactionalMessageWriter interface {
	CreateBotMessageInTx(ctx context.Context, tx Tx, input MessageWriteRequest) (GatewayMessage, error)
}

type CardGateway interface {
	CreateCustomBotCard(ctx context.Context, input CardCreateRequest) (Card, error)
	UpdateCustomBotCard(ctx context.Context, input CardUpdateRequest) (Card, error)
	InvalidateCustomBotCard(ctx context.Context, input CardUpdateRequest) (Card, error)
	ValidateMessageCardReference(ctx context.Context, actorID, conversationID string, block map[string]any) error
}

type TransactionalCardGateway interface {
	CreateCustomBotCardInTx(ctx context.Context, tx Tx, input CardCreateRequest) (Card, error)
}

type AttachmentWriter interface {
	ReserveAttachment(ctx context.Context, input AttachmentCreateRequest) (UploadReservation, error)
}

type TransactionalAttachmentWriter interface {
	ReserveAttachmentInTx(ctx context.Context, tx Tx, input AttachmentCreateRequest) (UploadReservation, error)
}

// TokenAuthenticator is an optional adapter for a separately owned Bot
// management service. Its result is still passed through ValidateAuth, so a
// revoked token or paused Bot cannot survive the gateway boundary.
type TokenAuthenticator interface {
	AuthenticateToken(ctx context.Context, rawToken string, options TokenAuthOptions) (*Auth, error)
}

var _ Repository = (*PGRepository)(nil)
