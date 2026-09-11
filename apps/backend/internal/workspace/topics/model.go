package topics

import (
	"encoding/json"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

const (
	DefaultSpaceID            = "spc_default"
	DefaultTopicLimit         = 50
	MaxTopicLimit             = 200
	DefaultMessageLimit       = 80
	MaxMessageLimit           = 200
	MessageContentFormat      = "duallane.message+json;v=1"
	MaxMessageTextCodePoints  = 30_000
	MaxMessageTextBytes       = 100 * 1024
	TopicTitleMaxCodePoints   = 40
	TopicDescriptionMaxPoints = 30_000
	TopicDescriptionMaxBytes  = 100 * 1024
	TopicCardType             = "workspace.topic-created"
	TopicSyncCardType         = "workspace.topic-message-synced"
	TopicCardSchemaVersion    = 1
	TopicTargetType           = "topic"
	TopicMessageTargetType    = "topic_message"
	ConversationTargetType    = "conversation"
	MessageTargetType         = "message"
)

const (
	StatusOpen     = "open"
	StatusClosed   = "closed"
	StatusArchived = "archived"
)

const (
	NotificationAll      = "all"
	NotificationMentions = "mentions"
	NotificationMuted    = "muted"
)

// Topic is the safe public topic projection. Description is nil for a group
// member who has not joined; DescriptionPreview is used in that summary view.
type Topic struct {
	ID                 string     `json:"id"`
	SpaceID            string     `json:"spaceId"`
	ConversationID     string     `json:"conversationId"`
	Title              string     `json:"title"`
	Description        *string    `json:"description,omitempty"`
	DescriptionPreview *string    `json:"descriptionPreview,omitempty"`
	CreatedBy          string     `json:"createdBy"`
	Creator            TopicActor `json:"creator"`
	Status             string     `json:"status"`
	AllowSyncToGroup   bool       `json:"allowSyncToGroup"`
	Revision           int64      `json:"revision"`
	ParticipantCount   int        `json:"participantCount"`
	Joined             bool       `json:"joined"`
	CanJoin            bool       `json:"canJoin"`
	CreatedAt          string     `json:"createdAt"`
	UpdatedAt          string     `json:"updatedAt"`
	ClosedAt           *string    `json:"closedAt"`
	ArchivedAt         *string    `json:"archivedAt"`
	ViewerID           string     `json:"viewerId"`
	LastReadMessageID  *string    `json:"lastReadMessageId"`
	LastReadSeq        int64      `json:"lastReadSeq"`
	NotificationLevel  string     `json:"notificationLevel"`
	UnreadCount        int64      `json:"unreadCount"`
}

type TopicActor struct {
	ID          string  `json:"id"`
	DisplayName string  `json:"displayName"`
	Nickname    *string `json:"nickname"`
	Remark      *string `json:"remark"`
	GitHubLogin string  `json:"githubLogin"`
	AvatarURL   *string `json:"avatarUrl"`
}

type TopicMember struct {
	UserID            string  `json:"userId"`
	JoinedAt          string  `json:"joinedAt"`
	NotificationLevel string  `json:"notificationLevel"`
	DisplayName       string  `json:"displayName"`
	Nickname          *string `json:"nickname"`
	GitHubLogin       string  `json:"githubLogin"`
	AvatarURL         *string `json:"avatarUrl"`
	Kind              string  `json:"kind"`
	Remark            *string `json:"remark"`
}

// Content is the existing versioned Workspace message envelope. The card
// fields are intentionally limited to the server-safe reference projection.
type Content struct {
	Format    string  `json:"format"`
	PlainText string  `json:"plainText"`
	Blocks    []Block `json:"blocks"`
}

type Block struct {
	Type          string          `json:"type"`
	Text          string          `json:"text,omitempty"`
	UserID        string          `json:"userId,omitempty"`
	Label         string          `json:"label,omitempty"`
	URL           string          `json:"url,omitempty"`
	Shortcode     string          `json:"shortcode,omitempty"`
	AttachmentID  string          `json:"attachmentId,omitempty"`
	CardID        string          `json:"cardId,omitempty"`
	CardType      string          `json:"cardType,omitempty"`
	SchemaVersion int             `json:"schemaVersion,omitempty"`
	FallbackText  string          `json:"fallbackText,omitempty"`
	ShareID       string          `json:"shareId,omitempty"`
	Share         json.RawMessage `json:"share,omitempty"`
	TopicID       string          `json:"topicId,omitempty"`
	Title         string          `json:"title,omitempty"`
}

type TopicMessage struct {
	ID                  string            `json:"id"`
	SpaceID             string            `json:"spaceId"`
	ConversationID      string            `json:"conversationId"`
	TopicID             string            `json:"topicId"`
	AuthorID            *string           `json:"authorId"`
	AuthorKind          string            `json:"authorKind"`
	Kind                string            `json:"kind"`
	ClientMessageID     *string           `json:"clientMessageId"`
	ContentFormat       string            `json:"contentFormat"`
	Content             Content           `json:"content"`
	PlainText           string            `json:"plainText"`
	ReplyToMessageID    *string           `json:"replyToMessageId"`
	CreatedAt           string            `json:"createdAt"`
	EditedAt            *string           `json:"editedAt"`
	DeletedAt           *string           `json:"deletedAt"`
	Author              TopicActor        `json:"author"`
	AuthorName          string            `json:"authorName"`
	AuthorNickname      string            `json:"authorNickname,omitempty"`
	AuthorRemark        string            `json:"authorRemark,omitempty"`
	AuthorGitHubLogin   string            `json:"authorGithubLogin,omitempty"`
	AuthorAvatarURL     string            `json:"authorAvatarUrl,omitempty"`
	Attachments         []json.RawMessage `json:"attachments"`
	Reactions           []json.RawMessage `json:"reactions"`
	HiddenByCurrentUser bool              `json:"hiddenByCurrentUser"`
	RecalledAt          *string           `json:"recalledAt"`
	RecallReason        *string           `json:"recallReason"`
	Pin                 json.RawMessage   `json:"pin,omitempty"`
}

type Projection struct {
	ID                  string  `json:"id"`
	TopicID             string  `json:"topicId"`
	TopicMessageID      string  `json:"topicMessageId"`
	GroupConversationID string  `json:"groupConversationId"`
	GroupMessageID      string  `json:"groupMessageId"`
	ProjectionType      string  `json:"projectionType"`
	CreatedAt           string  `json:"createdAt"`
	UpdatedAt           string  `json:"updatedAt"`
	RemovedAt           *string `json:"removedAt"`
}

type TopicMessageResult struct {
	Message  TopicMessage `json:"message"`
	Unread   int64        `json:"unread"`
	EventSeq int64        `json:"-"`
}

type ReadResult struct {
	TopicID           string  `json:"topicId"`
	LastReadMessageID *string `json:"lastReadMessageId"`
	LastReadSeq       int64   `json:"lastReadSeq"`
	UnreadCount       int64   `json:"unreadCount"`
}

type ProjectionResult struct {
	Projection *Projection `json:"projection"`
	Removed    bool        `json:"removed"`
}

type ListInput struct {
	ActorID        string
	SpaceID        string
	ConversationID string
	Status         string
	Mine           bool
	Limit          int
	Meta           auth.RequestMeta
}

type CreateInput struct {
	ActorID             string
	SpaceID             string
	ConversationID      string
	Title               string
	Description         string
	Source              string
	IdempotencyKey      string
	AllowSyncToGroup    bool
	AllowSyncToGroupSet bool
	Meta                auth.RequestMeta
}

type TopicInput struct {
	ActorID string
	SpaceID string
	TopicID string
	Meta    auth.RequestMeta
}

type TransitionInput struct {
	ActorID          string
	SpaceID          string
	TopicID          string
	ExpectedRevision int64
	Meta             auth.RequestMeta
}

type NotificationInput struct {
	ActorID           string
	SpaceID           string
	TopicID           string
	Level             string
	NotificationLevel string
	Meta              auth.RequestMeta
}

type MessageListInput struct {
	ActorID string
	SpaceID string
	TopicID string
	Before  string
	After   string
	Around  string
	Limit   int
	Meta    auth.RequestMeta
}

type CreateMessageInput struct {
	ActorID          string
	SpaceID          string
	TopicID          string
	ClientMessageID  string
	Content          Content
	Body             string
	ReplyToMessageID string
	SyncToGroup      bool
	Meta             auth.RequestMeta
}

type ReadInput struct {
	ActorID   string
	SpaceID   string
	TopicID   string
	MessageID string
	Meta      auth.RequestMeta
}

type SyncInput struct {
	ActorID   string
	SpaceID   string
	TopicID   string
	MessageID string
	Meta      auth.RequestMeta
}

type ProjectionListInput struct {
	ActorID string
	SpaceID string
	TopicID string
	Limit   int
	Meta    auth.RequestMeta
}

// Storage records deliberately have no JSON tags and must be projected before
// crossing a transport boundary.
type TopicRecord struct {
	ID                 string
	SpaceID            string
	ConversationID     string
	Title              string
	Description        string
	CreatedBy          string
	Status             string
	AllowSyncToGroup   bool
	Revision           int64
	CreatedAt          time.Time
	UpdatedAt          time.Time
	ClosedAt           *time.Time
	ArchivedAt         *time.Time
	CreatorDisplayName string
	CreatorNickname    *string
	CreatorGitHubLogin string
	CreatorAvatarURL   *string
	CreatorRemark      *string
	ParticipantCount   int
	Joined             bool
	LastReadMessageID  *string
	LastReadSeq        int64
	NotificationLevel  string
	UnreadCount        int64
}

type TopicMemberRecord struct {
	UserID            string
	JoinedAt          time.Time
	LeftAt            *time.Time
	NotificationLevel string
	DisplayName       string
	Nickname          *string
	GitHubLogin       string
	AvatarURL         *string
	Kind              string
	Remark            *string
}

type TopicMessageRecord struct {
	ID                string
	SpaceID           string
	ConversationID    string
	TopicID           string
	AuthorID          *string
	AuthorKind        string
	Kind              string
	ClientMessageID   *string
	ContentFormat     string
	ContentJSON       []byte
	PlainText         string
	ReplyToMessageID  *string
	CreatedAt         time.Time
	EditedAt          *time.Time
	DeletedAt         *time.Time
	RecalledAt        *time.Time
	AuthorDisplayName string
	AuthorNickname    *string
	AuthorGitHubLogin string
	AuthorAvatarURL   *string
	AuthorRemark      *string
	EventSeq          int64
}

type ProjectionRecord struct {
	ID                  string
	TopicID             string
	TopicMessageID      string
	GroupConversationID string
	GroupMessageID      string
	ProjectionType      string
	CreatedAt           time.Time
	UpdatedAt           time.Time
	RemovedAt           *time.Time
}

type CardRecord struct {
	ID              string
	SpaceID         string
	ConversationID  string
	CardType        string
	SchemaVersion   int
	PayloadJSON     []byte
	FallbackText    string
	SourceKind      string
	SourceID        string
	ResourceType    string
	ResourceID      string
	VisibilityScope string
	CreatedByUserID *string
	Status          string
	Revision        int64
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

type CardUpsert struct {
	ID              string
	SpaceID         string
	ConversationID  string
	CardType        string
	SchemaVersion   int
	PayloadJSON     []byte
	FallbackText    string
	SourceKind      string
	SourceID        string
	ResourceType    string
	ResourceID      string
	VisibilityScope string
	CreatedByUserID *string
	Status          string
	Now             time.Time
}

type CardUpsertResult struct {
	Card    CardRecord
	Created bool
	Changed bool
}

type RetentionRemoval struct {
	MessageID      string
	ProjectionID   string
	GroupMessageID string
}

type TopicListQuery struct {
	SpaceID        string
	ActorID        string
	ConversationID string
	Status         string
	Mine           bool
	Limit          int
}

type TopicMessageListQuery struct {
	SpaceID  string
	TopicID  string
	ViewerID string
	Before   *Cursor
	After    *Cursor
	Limit    int
}

type Cursor struct {
	ID        string
	CreatedAt time.Time
}

type EventInput struct {
	ID             string
	SpaceID        string
	Type           string
	ActorID        string
	ConversationID string
	TargetType     string
	TargetID       string
	PayloadJSON    []byte
	Payload        map[string]any
	CreatedAt      time.Time
}

type EventRecord struct {
	ID      string
	SpaceID string
	Seq     int64
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
