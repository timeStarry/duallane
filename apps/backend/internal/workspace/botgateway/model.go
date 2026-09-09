package botgateway

import (
	"encoding/json"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

const (
	Version            = 1
	DefaultSpaceID     = auth.DefaultSpaceID
	DefaultReplayLimit = 200
	MaxReplayLimit     = 200
	DefaultBatchSize   = 256
	MaxBatchSize       = 1000
	ReplayWindow       = 24 * time.Hour

	MessageContentFormat = "duallane.message+json;v=1"
	MaxMessageTextRunes  = 30_000
	MaxTriggerBytes      = 100 * 1024
	MaxTriggerBlocks     = 100
	MaxDeliveryDataBytes = 4 * 1024
	MaxDeliveryDataDepth = 3
	MaxDeliveryDataNodes = 30
	MaxDeliveryTextBytes = 2 * 1024
)

const (
	ScopeMessagesReadTrigger = "messages:read_trigger"
	ScopeMessagesReadContext = "messages:read_context"
	ScopeMessagesSend        = "messages:send"
	ScopeCardsWrite          = "cards:write"
	ScopeCardsAct            = "cards:act"
	ScopeFilesReadMetadata   = "files:read_metadata"
	ScopeFilesReadPreview    = "files:read_preview"
	ScopeFilesReadContent    = "files:read_content"
	ScopeFilesWrite          = "files:write"
	ScopeCommandsReceive     = "commands:receive"
)

// ScopeAllowlist is ordered to match the management service's public scope
// order. A gateway never accepts an arbitrary capability name from a caller.
var ScopeAllowlist = [...]string{
	ScopeMessagesReadTrigger,
	ScopeMessagesReadContext,
	ScopeMessagesSend,
	ScopeCardsWrite,
	ScopeCardsAct,
	ScopeFilesReadMetadata,
	ScopeFilesReadPreview,
	ScopeFilesReadContent,
	ScopeFilesWrite,
	ScopeCommandsReceive,
}

type TokenAuthOptions struct {
	SpaceID string
}

type Bot struct {
	ID                 string `json:"id"`
	BotUserID          string `json:"botUserId"`
	OwnerUserID        string `json:"ownerUserId,omitempty"`
	SpaceID            string `json:"spaceId"`
	Mode               string `json:"mode"`
	Name               string `json:"name"`
	VisibilityPolicy   string `json:"visibilityPolicy"`
	ConversationPolicy string `json:"conversationPolicy"`
	TriggerPolicy      string `json:"triggerPolicy"`
	Status             string `json:"status"`
	GitHubLogin        string `json:"githubLogin,omitempty"`
	NameNormalized     string `json:"nameNormalized,omitempty"`
}

type Auth struct {
	TokenID     string   `json:"-"`
	BotID       string   `json:"-"`
	UserID      string   `json:"-"`
	SpaceID     string   `json:"-"`
	OwnerUserID string   `json:"-"`
	Scopes      []string `json:"-"`
	Bot         Bot      `json:"-"`
}

type Settings struct {
	VisibilityPolicy          string
	AllowDirect               bool
	AllowGroup                bool
	GroupInviterPolicy        string
	RequireOwnerApproval      bool
	ProactiveEnabled          bool
	TriggerPolicy             string
	WelcomeMessage            string
	Description               string
	AvatarURL                 string
	ShowCreator               bool
	MaxContextMessages        int
	MaxContextChars           int
	MaxContextTokens          int
	ContextWindowSeconds      int
	IncludeReplies            bool
	IncludeSystemEvents       bool
	IncludeAttachmentMetadata bool
	AllowAttachmentPreview    bool
	LongTermSummaryEnabled    bool
}

type SettingsProjection struct {
	VisibilityPolicy     string        `json:"visibilityPolicy"`
	AllowDirect          bool          `json:"allowDirect"`
	AllowGroup           bool          `json:"allowGroup"`
	GroupInviterPolicy   string        `json:"groupInviterPolicy"`
	RequireOwnerApproval bool          `json:"requireOwnerApproval"`
	ProactiveEnabled     bool          `json:"proactiveEnabled"`
	TriggerPolicy        string        `json:"triggerPolicy"`
	Context              ContextLimits `json:"context"`
}

type ContextLimits struct {
	MaxMessages               int  `json:"maxMessages"`
	MaxChars                  int  `json:"maxChars"`
	MaxTokens                 int  `json:"maxTokens"`
	WindowSeconds             int  `json:"windowSeconds"`
	IncludeReplies            bool `json:"includeReplies"`
	IncludeSystemEvents       bool `json:"includeSystemEvents"`
	IncludeAttachmentMetadata bool `json:"includeAttachmentMetadata"`
	AllowAttachmentPreview    bool `json:"allowAttachmentPreview"`
	LongTermSummaryEnabled    bool `json:"longTermSummaryEnabled"`
}

type Connection struct {
	Status          string  `json:"status"`
	AdapterVersion  *string `json:"adapterVersion"`
	ConnectedAt     *string `json:"connectedAt"`
	DisconnectedAt  *string `json:"disconnectedAt"`
	LastHeartbeatAt *string `json:"lastHeartbeatAt"`
	LastProcessedAt *string `json:"lastProcessedAt"`
	LastErrorCode   *string `json:"lastErrorCode"`
	LastErrorAt     *string `json:"lastErrorAt"`
	UpdatedAt       string  `json:"updatedAt"`
}

// ConnectionRegistration is the non-secret state associated with one active
// gateway transport. The nonce is process-generated and is used to ensure a
// stale socket cannot mark a newer socket as disconnected.
type ConnectionRegistration struct {
	AdapterVersion string
	Nonce          string
}

type HeartbeatResult struct {
	Timestamp string `json:"timestamp"`
}

type Me struct {
	Version    int                 `json:"version"`
	Bot        map[string]any      `json:"bot"`
	SpaceID    string              `json:"spaceId"`
	Scopes     []string            `json:"scopes"`
	Settings   *SettingsProjection `json:"settings"`
	Connection *Connection         `json:"connection"`
}

type Conversation struct {
	ID             string    `json:"id"`
	SpaceID        string    `json:"-"`
	Type           string    `json:"type"`
	Title          string    `json:"title"`
	RetentionCount int64     `json:"-"`
	CreatedAt      time.Time `json:"-"`
}

type ConversationProjection struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	Title     string `json:"title"`
	CreatedAt string `json:"createdAt"`
}

type ContextMessageRecord struct {
	ID               string
	ConversationID   string
	AuthorID         *string
	AuthorKind       string
	Kind             string
	ContentFormat    string
	ContentJSON      []byte
	PlainText        string
	ReplyToMessageID *string
	CreatedAt        time.Time
}

type ContextMessage struct {
	ID               string         `json:"id"`
	ConversationID   string         `json:"conversationId"`
	AuthorID         *string        `json:"authorId"`
	AuthorKind       string         `json:"authorKind"`
	Kind             string         `json:"kind"`
	ContentFormat    string         `json:"contentFormat"`
	PlainText        string         `json:"plainText"`
	Content          map[string]any `json:"content"`
	ReplyToMessageID *string        `json:"replyToMessageId"`
	CreatedAt        string         `json:"createdAt"`
}

type MessageContent struct {
	Format    string           `json:"format"`
	PlainText string           `json:"plainText"`
	Blocks    []map[string]any `json:"blocks"`
	// Hash-only JSON retains the client's property order and UTF-16 strings.
	// It never bypasses message domain normalization or reaches response DTOs.
	hashPlainText json.RawMessage
	hashBlocks    json.RawMessage
}

type MessageWriteRequest struct {
	ActorID          string
	SpaceID          string
	ConversationID   string
	ClientMessageID  string
	ReplyToMessageID string
	Content          MessageContent
	Meta             auth.RequestMeta
}

type GatewayMessage struct {
	ID             string         `json:"id"`
	ConversationID string         `json:"conversationId"`
	PlainText      string         `json:"plainText"`
	Content        map[string]any `json:"content"`
	CreatedAt      string         `json:"createdAt"`
	Author         any            `json:"author,omitempty"`
}

type SendMessageInput struct {
	ConversationID   string
	ClientMessageID  string
	IdempotencyKey   string
	ReplyToMessageID string
	Text             string
	Content          any
	// RawContent/RawText are the original bounded JSON field bytes. When set,
	// they are authoritative over their decoded counterparts, preventing a
	// caller from hashing one value while writing a different value.
	RawContent json.RawMessage
	RawText    json.RawMessage
	// Fields is populated by a transport decoder when it needs to preserve
	// unknown input names for the gateway's forged-identity check.
	Fields map[string]any
	Meta   auth.RequestMeta
}

type SendMessageResult struct {
	Message         GatewayMessage `json:"message"`
	ClientMessageID string         `json:"clientMessageId"`
}

type Card struct {
	ID             string         `json:"id"`
	BotID          string         `json:"botId"`
	SpaceID        string         `json:"spaceId"`
	ConversationID string         `json:"conversationId"`
	CardType       string         `json:"cardType"`
	SchemaVersion  int            `json:"schemaVersion"`
	Payload        any            `json:"payload"`
	FallbackText   string         `json:"fallbackText"`
	Revision       int64          `json:"revision"`
	Status         string         `json:"status"`
	CreatedAt      string         `json:"createdAt"`
	UpdatedAt      string         `json:"updatedAt"`
	Block          map[string]any `json:"-"`
}

type CardCreateRequest struct {
	ActorID        string
	BotID          string
	BotUserID      string
	SpaceID        string
	ConversationID string
	SourceID       string
	CardType       string
	SchemaVersion  int
	FallbackText   string
	Payload        any
	// RawPayload is the already validated canonical representation that the
	// owning cards service must persist. It is never caller input.
	RawPayload json.RawMessage
	Meta       auth.RequestMeta
}

type CardUpdateRequest struct {
	ActorID          string
	BotID            string
	BotUserID        string
	SpaceID          string
	CardID           string
	ExpectedRevision int64
	Payload          any
	// RawPayload is the already validated canonical representation that the
	// owning cards service must persist. It is never caller input.
	RawPayload   json.RawMessage
	FallbackText *string
	Status       string
	Meta         auth.RequestMeta
}

type SendCardInput struct {
	ConversationID  string
	ClientMessageID string
	IdempotencyKey  string
	CardType        any
	SchemaVersion   any
	FallbackText    any
	Payload         any
	RawPayload      json.RawMessage
	Format          string
	FeishuCard      any
	// RawFeishuCard preserves HTTP JSON presence/order for the Node-compatible
	// Feishu conversion path. It is never persisted or hashed directly.
	RawFeishuCard json.RawMessage
	// RawFallbackText preserves HTTP JSON presence and UTF-16 units for the
	// Feishu fallback validation/hash path. It is never trusted without the
	// gateway's validation or persisted directly.
	RawFallbackText json.RawMessage
	Fields          map[string]any
	Meta            auth.RequestMeta
}

type SendCardResult struct {
	Card    Card           `json:"card"`
	Message GatewayMessage `json:"message"`
}

type UpdateCardInput struct {
	ExpectedRevision int64
	Payload          any
	FallbackText     *string
	Status           string
	Format           string
	FeishuCard       any
	// RawPayload and RawFeishuCard preserve input presence for Node-compatible
	// nullish selection. Only the converter's safe output is persisted.
	RawPayload      json.RawMessage
	RawFeishuCard   json.RawMessage
	RawFallbackText json.RawMessage
	Fields          map[string]any
	Meta            auth.RequestMeta
}

type AttachmentRecord struct {
	ID             string
	SpaceID        string
	UploaderID     string
	ConversationID *string
	Visibility     string
	Status         string
	FileName       string
	MIMEType       string
	ByteSize       int64
	CreatedAt      time.Time
	CompletedAt    *time.Time
}

type Attachment struct {
	ID             string  `json:"id"`
	SpaceID        string  `json:"spaceId"`
	UploaderID     string  `json:"uploaderId"`
	ConversationID *string `json:"conversationId"`
	Visibility     string  `json:"visibility"`
	Status         string  `json:"status"`
	FileName       string  `json:"fileName"`
	MIMEType       string  `json:"mimeType"`
	ByteSize       int64   `json:"byteSize"`
	CreatedAt      string  `json:"createdAt"`
	CompletedAt    *string `json:"completedAt"`
}

type AttachmentCreateRequest struct {
	ActorID        string
	SpaceID        string
	ConversationID string
	FileName       string
	MIMEType       string
	ByteSize       int64
	Visibility     string
	Meta           auth.RequestMeta
}

type CreateAttachmentInput struct {
	ConversationID string
	FileName       string
	MIMEType       string
	ByteSize       int64
	Visibility     string
	Fields         map[string]any
	Meta           auth.RequestMeta
}

type UploadReservation struct {
	Status     string      `json:"status"`
	ID         string      `json:"id,omitempty"`
	Attachment *Attachment `json:"attachment,omitempty"`
	Upload     any         `json:"upload,omitempty"`
}

type EventRecord struct {
	ID             string
	SpaceID        string
	Sequence       int64
	EventType      string
	ActorUserID    string
	ConversationID string
	TargetType     string
	TargetID       string
	PayloadJSON    []byte
	CreatedAt      time.Time
}

type DeliveryRecord struct {
	ID             string
	BotID          string
	SpaceID        string
	Sequence       int64
	EventID        string
	EventType      string
	ConversationID string
	PayloadJSON    []byte
	Status         string
	Attempts       int
	CreatedAt      time.Time
	ExpiresAt      time.Time
}

type Delivery struct {
	ID             string         `json:"id"`
	EventID        string         `json:"eventId"`
	Sequence       int64          `json:"sequence"`
	Type           string         `json:"type"`
	ConversationID string         `json:"conversationId"`
	Payload        map[string]any `json:"payload"`
	Status         string         `json:"status"`
	CreatedAt      string         `json:"createdAt"`
}

type DeliveryInsert struct {
	ID             string
	BotID          string
	SpaceID        string
	Sequence       int64
	EventID        string
	EventType      string
	ConversationID string
	PayloadJSON    []byte
	Status         string
	Attempts       int
	CreatedAt      time.Time
	ExpiresAt      time.Time
}

type Limits struct {
	RequestsPerMinute   int
	MemberDailyRequests int
	EventBacklogLimit   int
}

type MessageTrigger struct {
	AuthorID    string
	ContentJSON []byte
	PlainText   string
	DeletedAt   *time.Time
	RecalledAt  *time.Time
}

type Sender struct {
	ID   string
	Kind string
	Role string
}

type GroupPolicy struct {
	Status string
}

type ContextGrant struct {
	AllowTrigger bool
	AllowContext bool
	MaxMessages  *int
}

type IdempotencyRecord struct {
	RequestHash  string
	ResponseJSON []byte
	ExpiresAt    time.Time
}

type AcknowledgeInput struct {
	EventID  string
	Sequence int64
}

type AcknowledgeResult struct {
	Acknowledged bool   `json:"acknowledged"`
	EventID      string `json:"eventId"`
	Sequence     int64  `json:"sequence"`
}

type ReplayResult struct {
	Events          []Delivery `json:"events"`
	CurrentSequence int64      `json:"currentSequence"`
	SyncRequired    bool       `json:"syncRequired"`
	Reason          string     `json:"reason,omitempty"`
	HasMore         bool       `json:"hasMore,omitempty"`
}

type ReplayInput struct {
	LastSequence int64
	Limit        int
}

func projectSettings(settings *Settings) *SettingsProjection {
	if settings == nil {
		return nil
	}
	return &SettingsProjection{
		VisibilityPolicy:     settings.VisibilityPolicy,
		AllowDirect:          settings.AllowDirect,
		AllowGroup:           settings.AllowGroup,
		GroupInviterPolicy:   settings.GroupInviterPolicy,
		RequireOwnerApproval: settings.RequireOwnerApproval,
		ProactiveEnabled:     settings.ProactiveEnabled,
		TriggerPolicy:        settings.TriggerPolicy,
		Context: ContextLimits{
			MaxMessages:               settings.MaxContextMessages,
			MaxChars:                  settings.MaxContextChars,
			MaxTokens:                 settings.MaxContextTokens,
			WindowSeconds:             settings.ContextWindowSeconds,
			IncludeReplies:            settings.IncludeReplies,
			IncludeSystemEvents:       settings.IncludeSystemEvents,
			IncludeAttachmentMetadata: settings.IncludeAttachmentMetadata,
			AllowAttachmentPreview:    settings.AllowAttachmentPreview,
			LongTermSummaryEnabled:    settings.LongTermSummaryEnabled,
		},
	}
}

func projectConversation(value Conversation) ConversationProjection {
	return ConversationProjection{ID: value.ID, Type: value.Type, Title: value.Title, CreatedAt: timestamp(value.CreatedAt)}
}

func projectContextMessage(record ContextMessageRecord, includeAttachmentMetadata bool) ContextMessage {
	content := map[string]any{}
	var decoded any
	if len(record.ContentJSON) > 0 && json.Unmarshal(record.ContentJSON, &decoded) == nil {
		if object, ok := decoded.(map[string]any); ok {
			content = object
			if blocks, ok := object["blocks"].([]any); ok && !includeAttachmentMetadata {
				filtered := make([]any, 0, len(blocks))
				for _, value := range blocks {
					block, ok := value.(map[string]any)
					if !ok || block["type"] != "attachment" {
						filtered = append(filtered, value)
						continue
					}
					filtered = append(filtered, map[string]any{"type": "attachment", "attachmentId": block["attachmentId"]})
				}
				copy := make(map[string]any, len(object))
				for key, value := range object {
					copy[key] = value
				}
				copy["blocks"] = filtered
				content = copy
			}
		}
	}
	return ContextMessage{
		ID:               record.ID,
		ConversationID:   record.ConversationID,
		AuthorID:         cloneString(record.AuthorID),
		AuthorKind:       record.AuthorKind,
		Kind:             record.Kind,
		ContentFormat:    record.ContentFormat,
		PlainText:        record.PlainText,
		Content:          content,
		ReplyToMessageID: cloneString(record.ReplyToMessageID),
		CreatedAt:        timestamp(record.CreatedAt),
	}
}

func projectAttachment(record AttachmentRecord) Attachment {
	return Attachment{
		ID:             record.ID,
		SpaceID:        record.SpaceID,
		UploaderID:     record.UploaderID,
		ConversationID: cloneString(record.ConversationID),
		Visibility:     record.Visibility,
		Status:         record.Status,
		FileName:       record.FileName,
		MIMEType:       record.MIMEType,
		ByteSize:       record.ByteSize,
		CreatedAt:      timestamp(record.CreatedAt),
		CompletedAt:    timestampPointer(record.CompletedAt),
	}
}

func projectDelivery(record DeliveryRecord) Delivery {
	return Delivery{
		ID:             record.ID,
		EventID:        record.EventID,
		Sequence:       record.Sequence,
		Type:           record.EventType,
		ConversationID: record.ConversationID,
		Payload:        parseObject(record.PayloadJSON),
		Status:         record.Status,
		CreatedAt:      timestamp(record.CreatedAt),
	}
}

func timestamp(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func timestampPointer(value *time.Time) *string {
	if value == nil {
		return nil
	}
	result := timestamp(*value)
	return &result
}

func cloneString(value *string) *string {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func parseObject(raw []byte) map[string]any {
	var value map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil || value == nil {
		return map[string]any{}
	}
	return value
}
