package cards

import (
	"context"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

const (
	DefaultSpaceID        = auth.DefaultSpaceID
	CardBlockType         = "card"
	CardFallbackType      = "card_fallback"
	EventVersion          = 1
	MaxPayloadBytes       = 64 * 1024
	MaxPayloadDepth       = 8
	MaxPayloadNodes       = 200
	MaxPayloadTextBytes   = 16 * 1024
	MaxActionPayloadBytes = 16 * 1024
	MaxActionPayloadDepth = 6
	MaxActionPayloadNodes = 100
	MaxActionTextBytes    = 8 * 1024
)

var WorkspaceV1BlockTypes = [...]string{"text", "mention", "link", "emoji", "attachment", "emote_collection"}

type CardStatus string

const (
	StatusActive      CardStatus = "active"
	StatusInvalidated CardStatus = "invalidated"
	StatusExpired     CardStatus = "expired"
)

type SourceKind string

const (
	SourceWorkspace SourceKind = "workspace"
	SourceSystemBot SourceKind = "system_bot"
	SourceCustomBot SourceKind = "custom_bot"
	SourceEcho      SourceKind = "echo"
	SourceTopic     SourceKind = "topic"
)

type VisibilityScope string

const (
	VisibilitySpace        VisibilityScope = "space"
	VisibilityConversation VisibilityScope = "conversation"
	VisibilityResource     VisibilityScope = "resource"
)

// CardBlock is the stable, content-free reference persisted in a message.
type CardBlock struct {
	Type          string `json:"type"`
	CardID        string `json:"cardId"`
	CardType      string `json:"cardType"`
	SchemaVersion int    `json:"schemaVersion"`
	FallbackText  string `json:"fallbackText"`
}

// CardRecord is the storage projection and must not be sent directly to a
// client. PayloadJSON may contain private domain state.
type CardRecord struct {
	ID              string
	SpaceID         string
	ConversationID  *string
	CardType        string
	SchemaVersion   int
	PayloadJSON     []byte
	FallbackText    string
	SourceKind      SourceKind
	SourceID        *string
	ResourceType    *string
	ResourceID      *string
	VisibilityScope VisibilityScope
	CreatedByUserID *string
	Status          CardStatus
	Revision        int64
	ExpiresAt       *time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// Card is the known-definition public projection.
type Card struct {
	ID             string     `json:"id"`
	SpaceID        string     `json:"spaceId"`
	ConversationID *string    `json:"conversationId"`
	Block          CardBlock  `json:"block"`
	Payload        any        `json:"payload"`
	Status         CardStatus `json:"status"`
	Revision       int64      `json:"revision"`
	ExpiresAt      *string    `json:"expiresAt,omitempty"`
	CreatedAt      string     `json:"createdAt"`
	UpdatedAt      string     `json:"updatedAt"`
	Actions        []string   `json:"actions"`
}

// Resolution is returned by Resolve. Unknown versions deliberately expose only
// a fallback and never expose stored payload state.
type Resolution struct {
	Type           string     `json:"type"`
	Reason         string     `json:"reason,omitempty"`
	Block          CardBlock  `json:"block"`
	FallbackText   string     `json:"fallbackText,omitempty"`
	ID             string     `json:"id,omitempty"`
	SpaceID        string     `json:"spaceId,omitempty"`
	ConversationID *string    `json:"conversationId,omitempty"`
	Payload        any        `json:"payload,omitempty"`
	Status         CardStatus `json:"status,omitempty"`
	Revision       int64      `json:"revision,omitempty"`
	ExpiresAt      *string    `json:"expiresAt,omitempty"`
	CreatedAt      string     `json:"createdAt,omitempty"`
	UpdatedAt      string     `json:"updatedAt,omitempty"`
	Actions        []string   `json:"actions,omitempty"`
}

type Limits struct {
	MaxPayloadBytes int
	MaxDepth        int
	MaxNodes        int
	MaxTextBytes    int
}

var DefaultLimits = Limits{MaxPayloadBytes: MaxPayloadBytes, MaxDepth: MaxPayloadDepth, MaxNodes: MaxPayloadNodes, MaxTextBytes: MaxPayloadTextBytes}

type CardValidationError struct {
	Code    string
	Message string
}

func (e *CardValidationError) Error() string {
	if e == nil {
		return ""
	}
	return e.Code
}

type CardValidator func(payload any) (any, error)
type CardProjector func(context.Context, CardProjectContext) (any, error)
type CardAuthorizer func(context.Context, CardAuthorization) (bool, error)

type CardDefinition struct {
	CardType        string
	SchemaVersion   int
	ValidatePayload CardValidator
	ProjectPayload  CardProjector
	Authorize       CardAuthorizer
	Actions         map[string]CardAction
	AllowPublicURLs bool
	Limits          Limits
}

type CardAction struct {
	ID            string
	ValidateInput CardValidator
	Authorize     CardAuthorizer
	Execute       CardActionExecutor
	Limits        Limits
}

type CardProjectContext struct {
	Actor   *auth.Actor
	Card    Card
	Payload any
	Request Request
}

type CardAuthorization struct {
	Actor          *auth.Actor
	Card           Card
	Operation      string
	Input          any
	Request        Request
	ClientActionID string
}

type CardActionContext struct {
	Tx             Tx
	Actor          *auth.Actor
	Card           Card
	Payload        any
	Input          any
	ClientActionID string
	Request        Request
}

type CardActionResult struct {
	CardPayload any
	CardStatus  *CardStatus
	Result      any
}

type CardActionExecutor func(context.Context, CardActionContext) (CardActionResult, error)

type Request struct {
	Meta auth.RequestMeta
}

type CreateInput struct {
	ActorID                string
	SpaceID                string
	ConversationID         string
	CardID                 string
	CardType               string
	SchemaVersion          int
	FallbackText           string
	Payload                any
	SourceKind             SourceKind
	SourceID               string
	ResourceType           string
	ResourceID             string
	VisibilityScope        VisibilityScope
	CreatedByUserID        string
	ExpiresAt              *time.Time
	TrustedCustomBot       bool
	AllowUnknownDefinition bool
	BotID                  string
	Meta                   auth.RequestMeta
}

type CustomBotCreateInput struct {
	CreateInput
	BotID     string
	BotUserID string
}

type CustomBotUpdateInput struct {
	ActorID          string
	SpaceID          string
	CardID           string
	BotID            string
	BotUserID        string
	ExpectedRevision int64
	Payload          any
	FallbackText     *string
	Meta             auth.RequestMeta
}

type CustomBotInvalidateInput struct {
	ActorID          string
	SpaceID          string
	CardID           string
	BotID            string
	BotUserID        string
	ExpectedRevision int64
	Status           CardStatus
	Meta             auth.RequestMeta
}

type ActionInput struct {
	ActorID          string
	CardID           string
	ActionID         string
	ClientActionID   string
	ExpectedRevision int64
	Input            any
	Meta             auth.RequestMeta
}

type ActionOutcome struct {
	OK       bool  `json:"ok"`
	Replayed bool  `json:"replayed"`
	Result   any   `json:"result"`
	Revision int64 `json:"revision"`
}

type CardInsert struct {
	CardRecord
}

type ActionRunRecord struct {
	ID                string
	CardID            string
	ActorUserID       string
	ActionID          string
	ClientActionID    string
	RequestHash       string
	ExpectedRevision  int64
	Status            string
	ResultJSON        []byte
	ErrorCode         string
	ResultingRevision *int64
	CreatedAt         time.Time
	CompletedAt       *time.Time
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

func (r CardRecord) PublicBlock() CardBlock {
	return CardBlock{Type: CardBlockType, CardID: r.ID, CardType: r.CardType, SchemaVersion: r.SchemaVersion, FallbackText: r.FallbackText}
}

func formatTimestamp(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}
