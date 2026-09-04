package topics

import (
	"context"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messagejobs"
)

// ReadRepository is the narrow storage seam for the topic vertical. All
// resource checks are scoped by space and actor; callers must not authorize
// from an unscoped topic lookup.
type ReadRepository interface {
	LookupActor(context.Context, string, string) (*auth.Actor, error)
	GetConversation(context.Context, string, string) (*ConversationRecord, error)
	ConversationMemberActive(context.Context, string, string, string) (bool, error)
	ListTopics(context.Context, TopicListQuery) ([]TopicRecord, error)
	GetTopic(context.Context, string, string, string) (*TopicRecord, error)
	GetTopicByIdempotency(context.Context, string, string, string) (*TopicRecord, error)
	GetTopicMember(context.Context, string, string, string) (*TopicMemberRecord, error)
	ListTopicMembers(context.Context, string, string, string) ([]TopicMemberRecord, error)
	ListTopicMessages(context.Context, TopicMessageListQuery) ([]TopicMessageRecord, error)
	GetTopicMessage(context.Context, string, string, string) (*TopicMessageRecord, error)
	GetTopicMessageByClientID(context.Context, string, string, string, string) (*TopicMessageRecord, error)
	TopicUnread(context.Context, string, string, string) (int64, error)
	MessageEventSeq(context.Context, string, string) (int64, error)
	ListTopicProjections(context.Context, string, string, string, int) ([]ProjectionRecord, error)
	GetActiveProjection(context.Context, string, string, string) (*ProjectionRecord, error)
}

type ConversationRecord struct {
	ID             string
	SpaceID        string
	Type           string
	RetentionCount int64
}

type Repository interface {
	ReadRepository
	WithTx(context.Context, func(Tx) error) error
}

// Tx embeds reads so mutations can re-check current authorization after the
// stable topic/conversation lock is acquired. Related rows, audit evidence,
// and durable events are committed by one transaction.
type Tx interface {
	ReadRepository
	Lock(context.Context, string) error
	CreateTopic(context.Context, TopicInsert) error
	InsertTopicMember(context.Context, string, string, time.Time) (bool, error)
	RejoinTopicMember(context.Context, string, string, time.Time) (bool, error)
	LeaveTopicMember(context.Context, string, string, time.Time) (bool, error)
	TransitionTopic(context.Context, string, string, int64, time.Time) (*TopicRecord, bool, error)
	UpdateTopicNotification(context.Context, string, string, string) error
	InsertTopicMessage(context.Context, TopicMessageInsert) (bool, *TopicMessageRecord, error)
	InsertConversationMessage(context.Context, ConversationMessageInsert) (bool, error)
	EnforceTopicRetention(context.Context, string, int64, time.Time) ([]RetentionRemoval, error)
	CreateProjection(context.Context, ProjectionRecord) error
	ReactivateProjection(context.Context, string, string, time.Time) error
	UnsyncProjection(context.Context, string, time.Time) (bool, error)
	MarkGroupMessageDeleted(context.Context, string, time.Time) error
	UpsertCard(context.Context, CardUpsert) (CardUpsertResult, error)
	InvalidateCard(context.Context, string, time.Time) (CardRecord, bool, error)
	RefreshTopicCards(context.Context, string, string, time.Time) ([]CardRecord, error)
	MarkTopicRead(context.Context, string, string, *string, int64, time.Time) error
	WriteEvent(context.Context, EventInput) (EventRecord, error)
	WriteAudit(context.Context, AuditInput) error
}

type MessageJobTx interface {
	ScheduleMessageJobs(context.Context, messagejobs.Input) error
}

type TopicInsert struct {
	ID               string
	SpaceID          string
	ConversationID   string
	Title            string
	Description      string
	CreatedBy        string
	AllowSyncToGroup bool
	IdempotencyKey   *string
	CreatedAt        time.Time
}

type TopicMessageInsert struct {
	ID               string
	SpaceID          string
	ConversationID   string
	TopicID          string
	AuthorID         string
	AuthorKind       string
	Kind             string
	ClientMessageID  string
	ContentFormat    string
	ContentJSON      []byte
	PlainText        string
	ReplyToMessageID *string
	CreatedAt        time.Time
}

type ConversationMessageInsert struct {
	ID              string
	SpaceID         string
	ConversationID  string
	AuthorID        string
	AuthorKind      string
	Kind            string
	ClientMessageID string
	ContentFormat   string
	ContentJSON     []byte
	PlainText       string
	CreatedAt       time.Time
}

var _ Repository = (*PGRepository)(nil)
