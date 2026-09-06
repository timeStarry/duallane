package delivery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/solicitations"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

const (
	DefaultSpaceID = auth.DefaultSpaceID

	EchoUserID        = "usr_system_echo"
	EchoGitHubLogin   = "__duallane_echo__"
	DeliverySource    = "echo"
	CardTypeSol       = solicitations.CardType
	CardTypeRequest   = requirements.CardTypeRequirement
	CardTypeStatus    = requirements.CardTypeRequirementStatus
	CardTypeRelease   = "echo.release"
	CardSchemaVersion = 1

	DeliveryPending = "pending"
	DeliverySent    = "sent"
	DeliveryFailed  = "failed"
	DeliverySkipped = "skipped"

	DeliveryTypeSolicitation    = "solicitation"
	DeliveryTypeRequirement     = "requirement"
	DeliveryTypeRequirementStat = "requirement-status"
	DeliveryTypeRelease         = "release"

	EventDeliverySent        = "echo.delivery.sent"
	EventDeliveryFailed      = "echo.delivery.failed"
	EventDeliverySkipped     = "echo.delivery.skipped"
	EventConversationCreated = "conversation.created"

	DefaultBatchLimit       = 200
	DefaultRequirementLimit = 100
	DefaultLeaseTimeout     = 30 * time.Second
	MaxDeliveryErrorCode    = 128
)

var DefaultRetryDelays = [...]time.Duration{
	time.Minute,
	5 * time.Minute,
	30 * time.Minute,
}

// Clock and IDFactory are injectable so retry boundaries and PG integration
// tests do not depend on wall-clock sleeps or process-global randomness.
type Clock func() time.Time
type IDFactory func() (string, error)

// Error is the transport-neutral error returned by the delivery domain. It
// deliberately exposes only a stable code and status; bodies, card payloads,
// and request secrets never enter delivery results or audit reasons.
type Error struct {
	Code       string
	Message    string
	StatusCode int
	Cause      error
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	return e.Code
}

func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

func NewError(code, message string, statusCode int) *Error {
	return &Error{Code: strings.TrimSpace(code), Message: message, StatusCode: statusCode}
}

func internalError(operation string, cause error) *Error {
	if cause == nil {
		cause = errors.New("unknown error")
	}
	return &Error{Code: "echo.delivery_internal", Message: "服务暂时不可用", StatusCode: 500, Cause: fmt.Errorf("%s: %w", operation, cause)}
}

func notFoundError(code, message string) *Error {
	return &Error{Code: code, Message: message, StatusCode: 404}
}

// Projection is the only card data crossing from a domain projector into the
// delivery writer. The writer validates and persists it through the cards
// domain; delivery never exposes the payload in operational results.
type Projection struct {
	Block   CardBlock
	Payload any
}

type CardBlock struct {
	Type          string `json:"type"`
	CardID        string `json:"cardId"`
	CardType      string `json:"cardType"`
	SchemaVersion int    `json:"schemaVersion"`
	FallbackText  string `json:"fallbackText"`
}

// CardMessageWriteInput is the narrow atomic handoff to the parent-owned
// cards/messages adapter. The implementation must use the supplied Tx for
// the card upsert, message insert, card/message events and audits.
type CardMessageWriteInput struct {
	SpaceID          string
	ConversationID   string
	RecipientUserID  string
	CardID           string
	CardType         string
	SchemaVersion    int
	FallbackText     string
	Payload          any
	SourceID         string
	ResourceType     string
	ResourceID       string
	DomainRevision   int64
	ClientMessageID  string
	ContentPlainText string
	// InternalOnly is always true for Echo. The parent writer must reject a
	// false value and must not schedule email, ntfy, webhook, or other external
	// notification work for this internal Workspace delivery.
	InternalOnly bool
	Meta         auth.RequestMeta
}

type CardMessageWriteResult struct {
	CardID       string
	MessageID    string
	CardRevision int64
	Replayed     bool
}

// EchoWriter is implemented by the parent composition layer. It is
// intentionally delivery-owned so the worker cannot bypass the message/card
// domain services. Returning an error aborts the accepting transaction.
type EchoWriter interface {
	WriteEchoCardAndMessageInTx(context.Context, Tx, CardMessageWriteInput) (CardMessageWriteResult, error)
}

// TypedTransactionProvider is implemented by PGTransaction. A parent adapter
// may type-assert it and pass these views to messages.Service and
// cards.Service. No generic SQL handle is exposed.
type TypedTransactionProvider interface {
	MessageTransaction() messages.Tx
	CardTransaction() cards.Tx
}

type SolicitationProjector interface {
	ProjectCard(context.Context, solicitations.GetInput) (*solicitations.CardProjection, error)
}

type RequirementProjector interface {
	ProjectCard(context.Context, requirements.GetInput) (*requirements.CardProjection, error)
}

type ReleaseProjector interface {
	ProjectCard(context.Context, ReleaseProjectInput) (*ReleaseProjection, error)
}

// ReleaseProjectInput and ReleaseProjection are delivery-owned. The release
// publication service may change its catalog representation; the coordinator
// only depends on the recipient-authorized immutable card projection.
type ReleaseProjectInput struct {
	ActorID       string
	SpaceID       string
	PublicationID string
	Version       string
	Meta          auth.RequestMeta
}

type ReleaseProjection struct {
	Block   CardBlock
	Payload any
}

type ServiceOptions struct {
	Repository            Repository
	SpaceID               string
	Now                   Clock
	Writer                EchoWriter
	SolicitationProjector SolicitationProjector
	RequirementProjector  RequirementProjector
	ReleaseProjector      ReleaseProjector
	RetryDelays           []time.Duration
	MaxAttempts           int
	LeaseTimeout          time.Duration
	BatchLimit            int
	RequirementLimit      int
}

type Service struct {
	repo                  Repository
	spaceID               string
	now                   Clock
	writer                EchoWriter
	solicitationProjector SolicitationProjector
	requirementProjector  RequirementProjector
	releaseProjector      ReleaseProjector
	retryDelays           []time.Duration
	maxAttempts           int
	leaseTimeout          time.Duration
	batchLimit            int
	requirementLimit      int
}

type SolicitationDelivery struct {
	ID                    string
	SpaceID               string
	SolicitationID        string
	PublicID              string
	RecipientUserID       string
	Status                string
	AttemptCount          int
	LastErrorCode         *string
	DeliveredAt           *time.Time
	CreatedAt             time.Time
	UpdatedAt             time.Time
	SolicitationStatus    string
	DeliveryPolicy        string
	Revision              int64
	SolicitationUpdatedAt time.Time
}

type RequirementRecord struct {
	ID              string
	PublicID        string
	SpaceID         string
	SubmitterUserID string
	Revision        int64
	UpdatedAt       time.Time
}

type ReleaseDelivery struct {
	ID              string
	SpaceID         string
	PublicationID   string
	Version         string
	RecipientUserID string
	Status          string
	AttemptCount    int
	LastErrorCode   *string
	DeliveredAt     *time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
	PublishedAt     time.Time
}

type ExistingCard struct {
	ID          string
	CardType    string
	Revision    int64
	Status      string
	PayloadJSON []byte
}

type DirectConversation struct {
	ID      string
	SpaceID string
	Type    string
	Reused  bool
}

type EventInput struct {
	ID             string
	SpaceID        string
	Type           string
	ActorID        string
	ConversationID string
	TargetType     string
	TargetID       string
	Payload        any
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
	Meta             auth.RequestMeta
	CreatedAt        time.Time
}

type SyncInput struct {
	SpaceID         string
	SolicitationID  string
	PublicID        string
	Version         string
	RecipientUserID string
	CardType        string
	Force           bool
	Meta            auth.RequestMeta
}

type ProcessOptions struct {
	Limit            int
	RequirementLimit int
	Cursor           WorkCursor
	// Family lets a worker give each family its own bounded processor and
	// cursor, so a busy solicitation queue cannot consume a release's budget.
	Family string
}

// WorkCursor contains only the last inspected primary keys, never payloads.
// Retain each returned cursor between bounded worker cycles; an empty family
// cursor starts a fresh pass after reaching the end of that family.
type WorkCursor struct {
	Solicitation string
	Requirement  string
	Release      string
}

type DeliveryResult struct {
	Status          string `json:"status"`
	DeliveryID      string `json:"deliveryId,omitempty"`
	RecipientUserID string `json:"recipientUserId,omitempty"`
	CardID          string `json:"cardId,omitempty"`
	MessageID       string `json:"messageId,omitempty"`
	Replayed        bool   `json:"replayed,omitempty"`
	ErrorCode       string `json:"errorCode,omitempty"`
}

type DeliverySummary struct {
	Type    string
	Key     string
	Results []DeliveryResult
	Sent    int
	Failed  int
	Skipped int
}

type MemberSyncResult struct {
	RecipientUserID string
	Solicitations   []DeliveryResult
	Requirements    []DeliveryResult
	Releases        []DeliveryResult
}

type ProcessReport struct {
	Solicitations []DeliveryResult
	Requirements  []DeliverySummary
	Releases      []DeliveryResult
	Next          WorkCursor
}

type WorkspaceEvent struct {
	SpaceID  string
	Type     string
	TargetID string
	Payload  json.RawMessage
}

func (e WorkspaceEvent) payloadMap() map[string]any {
	if len(e.Payload) == 0 {
		return map[string]any{}
	}
	var payload map[string]any
	if err := json.Unmarshal(e.Payload, &payload); err != nil || payload == nil {
		return map[string]any{}
	}
	return payload
}

func (e WorkspaceEvent) payloadString(key string) string {
	value, _ := e.payloadMap()[key].(string)
	return strings.TrimSpace(value)
}

func (e WorkspaceEvent) normalizedTargetID() string {
	if target := strings.TrimSpace(e.TargetID); target != "" {
		return target
	}
	return e.payloadString("publicId")
}

func (e WorkspaceEvent) String() string {
	return fmt.Sprintf("%s:%s", strings.TrimSpace(e.Type), e.normalizedTargetID())
}
