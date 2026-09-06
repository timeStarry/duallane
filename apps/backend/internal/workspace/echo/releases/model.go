package releases

import (
	"context"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

const (
	DefaultSpaceID       = auth.DefaultSpaceID
	CardType             = "echo.release"
	CardSchemaVersion    = 1
	DeliveryPending      = "pending"
	DeliverySent         = "sent"
	DeliveryFailed       = "failed"
	DeliverySkipped      = "skipped"
	DefaultDeliveryLimit = 200
	MaxDeliveryLimit     = 200
)

type Clock func() time.Time
type IDFactory func() (string, error)

// Guide is the immutable, user-facing release guide registered in the shared
// catalog. A publication stores a JSON snapshot of this value, so later
// catalog edits cannot rewrite an already published card.
type Guide struct {
	Version    string         `json:"version"`
	ReleasedAt string         `json:"releasedAt"`
	Title      string         `json:"title"`
	Summary    string         `json:"summary"`
	Sections   []GuideSection `json:"sections"`
}

type GuideSection struct {
	Title string      `json:"title"`
	Items []GuideItem `json:"items"`
}

type GuideItem struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Location    string `json:"location"`
}

// GuideCatalog is a validated, read-only view of the registered catalog.
// Construct it with LoadGuideCatalog or NewGuideCatalog; its internal map is
// never exposed to callers.
type GuideCatalog struct {
	guides map[string]Guide
}

func (c GuideCatalog) Empty() bool {
	return len(c.guides) == 0
}

type PublicationRecord struct {
	ID                string
	SpaceID           string
	Version           string
	Title             string
	GuideHash         string
	GuideJSON         []byte
	PublishedByUserID string
	PublishedAt       time.Time
}

type PublicationSummary struct {
	ID             string `json:"id"`
	Version        string `json:"version"`
	Title          string `json:"title"`
	PublishedAt    string `json:"publishedAt"`
	RecipientCount int64  `json:"recipientCount"`
	PendingCount   int64  `json:"pendingCount"`
	SentCount      int64  `json:"sentCount"`
	FailedCount    int64  `json:"failedCount"`
	SkippedCount   int64  `json:"skippedCount"`
	Replayed       bool   `json:"replayed"`
}

type DeliverySummary struct {
	RecipientCount int64
	PendingCount   int64
	SentCount      int64
	FailedCount    int64
	SkippedCount   int64
}

type DeliveryRecord struct {
	ID              string
	SpaceID         string
	PublicationID   string
	Version         string
	RecipientUserID string
	RecipientKind   string
	RecipientActive bool
	Status          string
	AttemptCount    int
	LastErrorCode   *string
	DeliveredAt     *time.Time
	PublishedAt     time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

type DeliveryQuery struct {
	SpaceID         string
	Version         string
	RecipientUserID string
	Limit           int
}

type PublishInput struct {
	ActorID string
	SpaceID string
	Version string
	Meta    auth.RequestMeta
}

type ProjectCardInput struct {
	ActorID string
	SpaceID string
	Version string
}

type CardBlock struct {
	Type          string `json:"type"`
	CardID        string `json:"cardId"`
	CardType      string `json:"cardType"`
	SchemaVersion int    `json:"schemaVersion"`
	FallbackText  string `json:"fallbackText"`
}

type CardPayload struct {
	Version     string         `json:"version"`
	ReleasedAt  string         `json:"releasedAt"`
	Title       string         `json:"title"`
	Summary     string         `json:"summary"`
	Sections    []GuideSection `json:"sections"`
	PublishedAt string         `json:"publishedAt"`
}

type CardProjection struct {
	Block   CardBlock   `json:"block"`
	Payload CardPayload `json:"payload"`
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

type ServiceOptions struct {
	Repository Repository
	Catalog    GuideCatalog
	SpaceID    string
	Now        Clock
	IDFactory  IDFactory
}

type Service struct {
	repo    Repository
	catalog GuideCatalog
	spaceID string
	now     Clock
	newID   IDFactory
}

// CardProjector is the only release-domain capability needed by the Echo
// delivery coordinator. It returns an actor-filtered card projection and does
// not write messages or conversation state.
type CardProjector interface {
	ProjectCard(context.Context, ProjectCardInput) (*CardProjection, error)
}

// DeliveryRepository is the read-only persistence port reserved for the Echo
// delivery coordinator. It owns only release delivery rows; message, card,
// conversation, provider effects, claiming, scheduling, and retries stay
// outside this package.
type DeliveryRepository interface {
	ListDeliveries(context.Context, DeliveryQuery) ([]DeliveryRecord, error)
	GetDelivery(context.Context, string, string) (*DeliveryRecord, error)
}

// DeliveryCoordinatorPort is the read/project boundary the Echo delivery
// coordinator may inject. The releases package implements no delivery worker
// or delivery-state mutator.
type DeliveryCoordinatorPort interface {
	CardProjector
	DeliveryRepository
}

type ReadRepository interface {
	LookupActor(context.Context, string, string) (*auth.Actor, error)
	GetPublication(context.Context, string, string) (*PublicationRecord, error)
	GetPublicationForRecipient(context.Context, string, string, string) (*PublicationRecord, error)
	DeliverySummary(context.Context, string) (DeliverySummary, error)
}

type Repository interface {
	ReadRepository
	WithTx(context.Context, func(Tx) error) error
}

type Tx interface {
	ReadRepository
	Lock(context.Context, string) error
	InsertPublication(context.Context, PublicationRecord) error
	InsertDeliveryRows(context.Context, string, string, time.Time) error
	WriteAudit(context.Context, AuditInput) error
}

var _ CardProjector = (*Service)(nil)
