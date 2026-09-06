package requirements

import (
	"context"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

const (
	DefaultSpaceID        = auth.DefaultSpaceID
	DefaultListLimit      = 100
	MaxListLimit          = 100
	MaxTitleCodePoints    = 120
	MaxTitleBytes         = 512
	MaxBodyCodePoints     = 10_000
	MaxBodyBytes          = 64 * 1024
	MaxResponseCodePoints = 4_000
	MaxResponseCodePoint  = MaxResponseCodePoints // compatibility alias for early draft callers
	MaxResponseBytes      = 32 * 1024
	MaxRelatedLinkBytes   = 2_048
	MaxIdempotencyBytes   = 128
	MaxSequenceNumber     = 9_999
)

const (
	StateSubmitted   = "submitted"
	StateCollected   = "collected"
	StateInProgress  = "in_progress"
	StateImplemented = "implemented"
	StateRejected    = "rejected"
)

const (
	PhaseProposal = "proposal"
	PhaseFormal   = "formal"
	PhaseArchived = "archived"
)

const (
	StatusPendingReview = "pending_review"
	StatusPlanned       = "planned"
	StatusInProgress    = "in_progress"
	StatusDelivered     = "delivered"
	StatusArchived      = "archived"
)

const (
	ArchiveImplemented = "implemented"
	ArchiveRejected    = "rejected"
	ArchiveDuplicate   = "duplicate"
	ArchiveWithdrawn   = "withdrawn"
	ArchiveCancelled   = "cancelled"
)

const (
	TypeRequirement = "requirement"
	TypeSuggestion  = "suggestion"
	TypeProblem     = "problem"
)

var (
	RequirementStates         = [...]string{StateSubmitted, StateCollected, StateInProgress, StateImplemented, StateRejected}
	RequirementPhases         = [...]string{PhaseProposal, PhaseFormal, PhaseArchived}
	RequirementStatuses       = [...]string{StatusPendingReview, StatusPlanned, StatusInProgress, StatusDelivered, StatusArchived}
	RequirementArchiveResults = [...]string{ArchiveImplemented, ArchiveRejected, ArchiveDuplicate, ArchiveWithdrawn, ArchiveCancelled}
	RequirementTypes          = [...]string{TypeRequirement, TypeSuggestion, TypeProblem}
)

const (
	CardTypeRequirement       = "echo.request"
	CardTypeRequirementStatus = "echo.request-status"
	CardTypeRequirementList   = "echo.request-list"
	CardSchemaVersion         = 1
)

var RequirementCardTypes = [...]string{CardTypeRequirement, CardTypeRequirementStatus, CardTypeRequirementList}

type Clock func() time.Time
type IDFactory func() (string, error)

// RequirementRecord is the storage projection. It must be projected before it
// crosses a transport boundary; the service applies visibility first.
type RequirementRecord struct {
	ID                   string
	PublicID             string
	SpaceID              string
	SubmitterUserID      string
	SubmitterDisplayName string
	SubmitterGithubLogin string
	Type                 string
	Title                string
	Detail               string
	Scenario             string
	ExpectedResult       string
	RelatedLink          *string
	State                string
	Phase                string
	Status               string
	ArchiveOutcome       *string
	DuplicateOfPublicID  *string
	Revision             int64
	Response             *string
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

// Requirement is the private, actor-authorized public projection. Body fields
// are intentionally present only after the service has completed its access
// check.
type Requirement struct {
	ID                   string  `json:"id"`
	PublicID             string  `json:"publicId"`
	SpaceID              string  `json:"spaceId"`
	SubmitterUserID      string  `json:"submitterUserId"`
	SubmitterDisplayName *string `json:"submitterDisplayName"`
	SubmitterGithubLogin *string `json:"submitterGithubLogin"`
	Type                 string  `json:"type"`
	Title                string  `json:"title"`
	Detail               string  `json:"detail"`
	Scenario             string  `json:"scenario"`
	ExpectedResult       string  `json:"expectedResult"`
	RelatedLink          *string `json:"relatedLink"`
	State                string  `json:"state"`
	Phase                string  `json:"phase"`
	Status               string  `json:"status"`
	ArchiveOutcome       *string `json:"archiveOutcome"`
	DuplicateOfPublicID  *string `json:"duplicateOfPublicId"`
	Revision             int64   `json:"revision"`
	Response             *string `json:"response"`
	CreatedAt            string  `json:"createdAt"`
	UpdatedAt            string  `json:"updatedAt"`
}

type RequirementHistoryRecord struct {
	ID             string
	RequirementID  string
	FromState      *string
	ToState        string
	FromPhase      *string
	FromStatus     *string
	ToPhase        string
	ToStatus       string
	Response       *string
	ActorUserID    string
	Revision       int64
	IdempotencyKey *string
	CreatedAt      time.Time
}

type RequirementHistory struct {
	ID          string  `json:"id"`
	FromState   *string `json:"fromState"`
	ToState     string  `json:"toState"`
	FromPhase   *string `json:"fromPhase"`
	FromStatus  *string `json:"fromStatus"`
	ToPhase     string  `json:"toPhase"`
	ToStatus    string  `json:"toStatus"`
	Response    *string `json:"response"`
	ActorUserID string  `json:"actorUserId"`
	Revision    int64   `json:"revision"`
	// IdempotencyKey is retained for Go callers that used the early draft, but
	// it is never part of the public Echo history projection.
	IdempotencyKey *string `json:"-"`
	CreatedAt      string  `json:"createdAt"`
}

type RequirementPageRecord struct {
	Items []RequirementRecord
	Total int64
}

type RequirementPage struct {
	Items    []Requirement `json:"requirements"`
	Total    int64         `json:"total"`
	PageInfo PageInfo      `json:"pageInfo"`
}

type PageInfo struct {
	Offset     int  `json:"offset"`
	Limit      int  `json:"limit"`
	HasNext    bool `json:"hasNext"`
	NextOffset *int `json:"nextOffset"`
}

type RequirementStatsRow struct {
	Phase  string
	Status string
	Count  int64
}

type RequirementStats struct {
	Total    int64            `json:"total"`
	ByPhase  map[string]int64 `json:"byPhase"`
	ByStatus map[string]int64 `json:"byStatus"`
}

type IdempotencyRecord struct {
	SpaceID           string
	ActorUserID       string
	Operation         string
	Key               string
	RequestHash       string
	RequirementID     string
	ResultingState    string
	ResultingRevision int64
	ResultJSON        []byte
	CreatedAt         time.Time
}

type RequirementListQuery struct {
	SpaceID         string
	ActorID         string
	Owner           bool
	State           *string
	Phase           *string
	Status          *string
	ArchiveOutcome  *string
	Type            *string
	SubmitterUserID *string
	CreatedFrom     *time.Time
	CreatedTo       *time.Time
	Limit           int
	Offset          int
}

type SubmitInput struct {
	ActorID        string
	SpaceID        string
	Type           string
	Title          string
	Detail         string
	Scenario       string
	ExpectedResult string
	RelatedLink    string
	IdempotencyKey string
	Meta           auth.RequestMeta
}

type GetInput struct {
	ActorID  string
	SpaceID  string
	PublicID string
	Meta     auth.RequestMeta
	CardType string
}

type ListInput struct {
	ActorID         string
	SpaceID         string
	State           string
	Phase           string
	Status          string
	ArchiveOutcome  string
	Type            string
	SubmitterUserID string
	CreatedFrom     string
	CreatedTo       string
	Limit           int
	Offset          int
	Meta            auth.RequestMeta
}

type StatsInput struct {
	ActorID string
	SpaceID string
	Meta    auth.RequestMeta
}

type HistoryInput struct {
	ActorID  string
	SpaceID  string
	PublicID string
	Meta     auth.RequestMeta
}

type TransitionInput struct {
	ActorID             string
	SpaceID             string
	PublicID            string
	ToState             string
	State               string
	ToPhase             string
	Phase               string
	ToStatus            string
	Status              string
	ArchiveOutcome      string
	DuplicateOfPublicID string
	Response            string
	ExpectedRevision    int64
	IdempotencyKey      string
	Meta                auth.RequestMeta
	// ResponseSet lets an adapter preserve the Node distinction between an
	// omitted response and an explicitly supplied empty response.
	ResponseSet bool
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

type EventInput struct {
	ID          string
	SpaceID     string
	Type        string
	ActorID     string
	TargetType  string
	TargetID    string
	PayloadJSON []byte
	CreatedAt   time.Time
}

type EventRecord struct {
	ID      string
	SpaceID string
	Seq     int64
}

type RequirementEvent struct {
	Type       string                  `json:"type"`
	TargetType string                  `json:"targetType"`
	TargetID   string                  `json:"targetId"`
	Payload    RequirementEventPayload `json:"payload"`
}

type RequirementEventPayload struct {
	PublicID            string               `json:"publicId"`
	State               string               `json:"state"`
	Phase               string               `json:"phase"`
	Status              string               `json:"status"`
	ArchiveOutcome      *string              `json:"archiveOutcome"`
	DuplicateOfPublicID *string              `json:"duplicateOfPublicId"`
	Revision            int64                `json:"revision"`
	Card                RequirementEventCard `json:"card"`
}

// RequirementEventCard deliberately omits the message-block type. Echo event
// payloads carry a card reference, not a full workspace message block.
type RequirementEventCard struct {
	CardID        string `json:"cardId"`
	CardType      string `json:"cardType"`
	SchemaVersion int    `json:"schemaVersion"`
	FallbackText  string `json:"fallbackText"`
}

type CardProjection struct {
	Block   CardBlock      `json:"block"`
	Payload map[string]any `json:"payload"`
}

type CardBlock struct {
	Type          string `json:"type"`
	CardID        string `json:"cardId"`
	CardType      string `json:"cardType"`
	SchemaVersion int    `json:"schemaVersion"`
	FallbackText  string `json:"fallbackText"`
}

type ReadRepository interface {
	LookupActor(context.Context, string, string) (*auth.Actor, error)
	GetRequirementByPublicID(context.Context, string, string) (*RequirementRecord, error)
	GetRequirementByID(context.Context, string, string) (*RequirementRecord, error)
	ListRequirements(context.Context, RequirementListQuery) (RequirementPageRecord, error)
	RequirementStats(context.Context, string, string, bool) ([]RequirementStatsRow, error)
	ListRequirementHistory(context.Context, string, string) ([]RequirementHistoryRecord, error)
	GetIdempotency(context.Context, string, string, string, string) (*IdempotencyRecord, error)
}

type Repository interface {
	ReadRepository
	WithTx(context.Context, func(Tx) error) error
}

type Tx interface {
	ReadRepository
	Lock(context.Context, string) error
	AllocateSequence(context.Context, string, int) (int, error)
	InsertRequirement(context.Context, RequirementRecord) error
	InsertHistory(context.Context, RequirementHistoryRecord) error
	InsertIdempotency(context.Context, IdempotencyRecord) (bool, error)
	UpdateIdempotencyResult(context.Context, string, string, string, string, []byte) error
	UpdateRequirementCAS(context.Context, string, int64, RequirementRecord) (bool, error)
	WriteAudit(context.Context, AuditInput) error
	WriteEvent(context.Context, EventInput) (EventRecord, error)
}

var _ Repository = (*PGRepository)(nil)
