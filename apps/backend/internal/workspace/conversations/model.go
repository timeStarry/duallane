package conversations

import (
	"time"

	workspaceMembers "github.com/timestarry/duallane/apps/backend/internal/workspace/members"
	workspaceMessages "github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

const (
	DefaultSpaceID          = "spc_default"
	DefaultRetentionCount   = int64(10000)
	MaxConversationTitleLen = 80
	MaxPinnedMessages       = 3
)

type ConversationType string

const (
	ConversationTypeDirect ConversationType = "direct"
	ConversationTypeGroup  ConversationType = "group"
)

type NotificationLevel string

const (
	NotificationAll      NotificationLevel = "all"
	NotificationMentions NotificationLevel = "mentions"
	NotificationMuted    NotificationLevel = "muted"
)

type MemberCapabilities = workspaceMembers.MemberCapabilities
type Member = workspaceMembers.Member

type ConversationCapabilities struct {
	CanSendMessage   bool `json:"canSendMessage"`
	CanUploadFile    bool `json:"canUploadFile"`
	CanManageMembers bool `json:"canManageMembers"`
}

type Conversation struct {
	ID                   string                   `json:"id"`
	SpaceID              string                   `json:"spaceId"`
	Type                 string                   `json:"type"`
	Title                string                   `json:"title"`
	AvatarEmoji          *string                  `json:"avatarEmoji"`
	DisplayTitle         string                   `json:"displayTitle"`
	OtherMember          *Member                  `json:"otherMember"`
	RetentionCount       int64                    `json:"retentionCount"`
	RetentionText        string                   `json:"retentionText"`
	CreatedAt            string                   `json:"createdAt"`
	LastActivityAt       string                   `json:"lastActivityAt"`
	MessageCount         int64                    `json:"messageCount"`
	MemberCount          int                      `json:"memberCount"`
	LastMessagePlainText string                   `json:"lastMessagePlainText"`
	LastMessageAt        *string                  `json:"lastMessageAt"`
	UnreadCount          int64                    `json:"unreadCount"`
	LastReadMessageID    *string                  `json:"lastReadMessageId"`
	LastReadAt           *string                  `json:"lastReadAt"`
	LastReadSeq          *int64                   `json:"lastReadSeq"`
	NotificationLevel    string                   `json:"notificationLevel"`
	Capabilities         ConversationCapabilities `json:"capabilities"`
	Members              []Member                 `json:"members"`
	LatestMessages       []Message                `json:"latestMessages"`
}

type MessagePin struct {
	PinnedByUserID string `json:"pinnedByUserId"`
	PinnedAt       string `json:"pinnedAt"`
	CanUnpin       bool   `json:"canUnpin"`
}

// Message embeds the canonical Workspace message projection. Pin is owned by
// this package because pin authorization and lifecycle are conversation
// concerns; all other message JSON fields come from the messages package.
type Message struct {
	workspaceMessages.Message
	Pin *MessagePin `json:"pin,omitempty"`
}

// ConversationRecord is a storage projection. It deliberately does not have
// JSON tags because it must never be returned directly from an HTTP handler.
type ConversationRecord struct {
	ID                string
	SpaceID           string
	Type              string
	Title             string
	AvatarEmoji       *string
	RetentionCount    int64
	CreatedBy         string
	CreatedAt         time.Time
	LastActivityAt    time.Time
	MessageCount      int64
	UnreadCount       int64
	LastReadMessageID *string
	LastReadAt        *time.Time
	LastReadSeq       *int64
	NotificationLevel string
}

type MemberRecord = workspaceMembers.MemberRecord

type MessageRecord struct {
	ID                  string
	ConversationID      string
	AuthorID            *string
	AuthorName          string
	AuthorNickname      string
	AuthorRemark        string
	AuthorGitHubLogin   string
	AuthorAvatarURL     string
	AuthorKind          string
	Kind                string
	ClientMessageID     *string
	ContentJSON         []byte
	PlainText           string
	ReplyToMessageID    *string
	CreatedAt           time.Time
	EditedAt            *time.Time
	DeletedAt           *time.Time
	RecalledAt          *time.Time
	RecallReason        *string
	HiddenByCurrentUser bool
	// Attachments is populated by the conversation read adapter before a
	// message is projected. Keeping it on the storage record avoids returning
	// a message whose content references attachments that the public DTO cannot
	// resolve.
	Attachments []workspaceMessages.AttachmentRecord
	// EmoteCollectionShares is an authorized read-only projection populated by
	// the optional messages share reader. It is never persisted by this domain.
	EmoteCollectionShares map[string]workspaceMessages.EmoteCollectionShare
	Pin                   *PinRecord
}

type PinRecord struct {
	MessageID      string
	PinnedByUserID string
	CreatedAt      time.Time
	Message        MessageRecord
}

type CreateConversationRecord struct {
	ID             string
	SpaceID        string
	Type           string
	Title          string
	AvatarEmoji    *string
	DirectKey      *string
	RetentionCount int64
	CreatedBy      string
	CreatedAt      time.Time
}

type SystemMessageInsert struct {
	ID             string
	SpaceID        string
	ConversationID string
	ContentJSON    []byte
	PlainText      string
	CreatedAt      time.Time
}

type ReadMarker struct {
	MessageID *string
	ReadAt    time.Time
	Sequence  int64
}

type LeaveResult struct {
	OK             bool   `json:"ok"`
	ConversationID string `json:"conversationId"`
}

type UnpinResult struct {
	MessageID string `json:"messageId"`
	Removed   bool   `json:"removed"`
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
	CreatedAt      time.Time
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

type PinListItem struct {
	MessageID      string  `json:"messageId"`
	PinnedByUserID string  `json:"pinnedByUserId"`
	PinnedAt       string  `json:"pinnedAt"`
	CanUnpin       bool    `json:"canUnpin"`
	Message        Message `json:"message"`
}
