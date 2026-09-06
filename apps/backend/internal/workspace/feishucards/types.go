package feishucards

import (
	"context"
	"encoding/json"
)

const (
	CardType        = "feishu.adaptive.v1"
	SchemaVersion   = 1
	PayloadFormat   = "duallane.feishu-card.v1"
	DefaultFallback = "Bot 卡片"
)

var ActionIDs = [...]string{"cancel", "confirm", "refresh", "submit"}

// Limits intentionally match the Node converter's independent Feishu
// element limits. The generic Workspace card limits are broader.
type Limits struct {
	MaxDepth        int
	MaxNodes        int
	MaxTextBytes    int
	MaxPayloadBytes int
}

var DefaultLimits = Limits{
	MaxDepth:        10,
	MaxNodes:        80,
	MaxTextBytes:    12 * 1024,
	MaxPayloadBytes: 48 * 1024,
}

var ActionLimits = Limits{
	MaxDepth:        3,
	MaxNodes:        30,
	MaxTextBytes:    2 * 1024,
	MaxPayloadBytes: 4 * 1024,
}

type Options struct {
	Limits         Limits
	AllowedActions []string
}

// Payload is the typed public projection. PayloadJSON is the authoritative
// ordered representation for cross-runtime hashing and persistence.
type Payload struct {
	Format   string    `json:"format"`
	Config   Config    `json:"config"`
	Header   *Header   `json:"header"`
	Elements []Element `json:"elements"`
}

type Config struct {
	Version    string `json:"version"`
	WideScreen bool   `json:"wideScreen"`
}

type Header struct {
	Title    string  `json:"title"`
	Subtitle *string `json:"subtitle,omitempty"`
	Tone     string  `json:"tone"`
}

type TextPart struct {
	Format string `json:"format"`
	Text   string `json:"text"`
}

// Element is a discriminated DTO. Only the fields matching Type are set.
type Element struct {
	Type    string     `json:"type"`
	Format  string     `json:"format,omitempty"`
	Text    string     `json:"text,omitempty"`
	Parts   []TextPart `json:"parts,omitempty"`
	Buttons []Button   `json:"buttons,omitempty"`
	Columns []Column   `json:"columns,omitempty"`
}

type Button struct {
	Type     string `json:"type"`
	Label    string `json:"label"`
	ActionID string `json:"actionId"`
	Style    string `json:"style"`
	Data     any    `json:"data"`
}

type Column struct {
	Width    string    `json:"width"`
	Weight   *int      `json:"weight,omitempty"`
	Elements []Element `json:"elements"`
}

type Result struct {
	CardType      string  `json:"cardType"`
	SchemaVersion int     `json:"schemaVersion"`
	Payload       Payload `json:"payload"`
	FallbackText  string  `json:"fallbackText"`
	PayloadJSON   []byte  `json:"-"`
	HashJSON      []byte  `json:"-"`
}

// Definition is intentionally independent of the storage service. Parent
// composition can adapt it to the shared card registry without making this
// converter a second persistence owner.
type Definition struct {
	CardType        string
	SchemaVersion   int
	AllowPublicURLs bool
	Limits          Limits
	Actions         map[string]ActionDefinition
	ValidatePayload func(any) (any, error)
}

type ActionDefinition struct {
	ID            string
	Limits        Limits
	ValidateInput func(any) (any, error)
	Execute       func(context.Context, ActionContext) (ActionResult, error)
}

type CardRef struct {
	ID             string
	SpaceID        string
	ConversationID string
}

type BotBinding struct {
	ID     string
	UserID string
}

// Tx is the only persistence boundary exposed by this package. A parent
// adapter implements it over its caller-owned typed card transaction. The
// converter never opens a connection, starts a transaction, or writes SQL.
type Tx interface {
	FindActiveBotForCard(context.Context, string, string) (BotBinding, bool, error)
	WriteCardActionEvent(context.Context, CardActionEvent) error
}

type CardActionEvent struct {
	SpaceID        string
	Type           string
	ActorID        string
	ConversationID string
	TargetType     string
	TargetID       string
	PayloadJSON    []byte
}

type ActionContext struct {
	Tx             Tx
	ActorID        string
	Card           CardRef
	Payload        any
	Input          any
	ClientActionID string
}

type ActionResult struct {
	Result any
}

func cloneBytes(value []byte) []byte {
	return append([]byte(nil), value...)
}

func rawMessage(value any) (json.RawMessage, error) {
	switch typed := value.(type) {
	case json.RawMessage:
		return cloneBytes(typed), nil
	case []byte:
		return cloneBytes(typed), nil
	default:
		return json.Marshal(value)
	}
}
