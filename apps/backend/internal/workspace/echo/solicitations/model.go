package solicitations

import (
	"context"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
)

const (
	DefaultSpaceID       = auth.DefaultSpaceID
	DefaultListLimit     = 100
	MaxListLimit         = 100
	MaxTitleCodePoints   = 120
	MaxTitleBytes        = 512
	MaxBodyCodePoints    = 10_000
	MaxBodyBytes         = 64 * 1024
	MaxOptionCodePoints  = 256
	MaxOptionBytes       = 2_048
	MaxOptions           = 20
	MinOptions           = 2
	MaxIdempotencyBytes  = 128
	MaxSequenceNumber    = 9_999
	MaxDeliveryErrorCode = 128
)

const (
	StatusDraft     = "draft"
	StatusOpen      = "open"
	StatusClosed    = "closed"
	StatusWithdrawn = "withdrawn"
)

const (
	ChoiceSingle   = "single"
	ChoiceMultiple = "multiple"
)

const (
	ResultVisibilityAggregate = "aggregate"
	ResultVisibilityOwner     = "owner"
)

const (
	DeliveryPolicyAllActiveMembers = "all_active_members"
	DeliveryPolicyNone             = "none"
)

const (
	DeliveryPending = "pending"
	DeliverySent    = "sent"
	DeliveryFailed  = "failed"
	DeliverySkipped = "skipped"
)

const (
	CardType          = "echo.solicitation"
	CardSchemaVersion = 1
)

var (
	SolicitationStatuses = [...]string{StatusDraft, StatusOpen, StatusClosed, StatusWithdrawn}
	ChoiceModes          = [...]string{ChoiceSingle, ChoiceMultiple}
	DeliveryStatuses     = [...]string{DeliveryPending, DeliverySent, DeliveryFailed, DeliverySkipped}
)

type Clock func() time.Time
type IDFactory func() (string, error)

// ConversationAccess is implemented by the existing cards/messages or
// conversations storage adapter. The solicitation domain only asks whether
// the actor is still an active member of the target conversation; it does not
// compose a second conversation authorization query.
type ConversationAccess interface {
	ConversationMemberActive(context.Context, string, string, string) (bool, error)
}

// RequirementAdapter is a typed handoff boundary for the Echo runtime. The
// solicitation domain does not call requirement storage or merge projections;
// the parent runtime may use this port when it assembles combined Echo cards
// and commands.
type RequirementAdapter interface {
	Get(context.Context, requirements.GetInput) (*requirements.Requirement, error)
	ProjectCard(context.Context, requirements.GetInput) (*requirements.CardProjection, error)
}

type ServiceOptions struct {
	Repository         Repository
	SpaceID            string
	Now                Clock
	IDFactory          IDFactory
	ConversationAccess ConversationAccess
	Requirements       RequirementAdapter
}

type Service struct {
	repo               Repository
	spaceID            string
	now                Clock
	idFactory          IDFactory
	conversationAccess ConversationAccess
	requirements       RequirementAdapter
}

type SolicitationRecord struct {
	ID               string
	PublicID         string
	SpaceID          string
	OwnerUserID      string
	Title            string
	Description      string
	Question         string
	ChoiceMode       string
	MinSelections    int
	MaxSelections    int
	AllowVoteChange  bool
	ResultVisibility string
	DeliveryPolicy   string
	Status           string
	Deadline         *time.Time
	Revision         int64
	IdempotencyKey   *string
	CreatedAt        time.Time
	UpdatedAt        time.Time
	PublishedAt      *time.Time
	ClosedAt         *time.Time
	WithdrawnAt      *time.Time
}

type SolicitationOptionRecord struct {
	ID             string
	SolicitationID string
	Label          string
	Position       int
}

type VoteRecord struct {
	ID               string
	SolicitationID   string
	VoterUserID      string
	VoterDisplayName string
	VoterGitHubLogin string
	Selection        []string
	Revision         int64
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

type DeliveryRecord struct {
	ID                   string
	SpaceID              string
	SolicitationID       string
	RecipientUserID      string
	RecipientDisplayName string
	RecipientGitHubLogin string
	Status               string
	AttemptCount         int
	LastErrorCode        *string
	DeliveredAt          *time.Time
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

type IdempotencyRecord struct {
	SpaceID        string
	ActorUserID    string
	Operation      string
	Key            string
	RequestHash    string
	SolicitationID string
	ResultJSON     []byte
	CreatedAt      time.Time
}

type SolicitationOption struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Position int    `json:"position"`
}

type DeliverySummary map[string]int64

type OwnerProjection struct {
	DeliverySummary DeliverySummary `json:"deliverySummary"`
	CanViewVoters   bool            `json:"canViewVoters"`
}

// Solicitation is the actor-authorized domain projection. Counts and voter
// details are intentionally actor-filtered by the service before projection.
type Solicitation struct {
	ID                string               `json:"id"`
	PublicID          string               `json:"publicId"`
	SpaceID           string               `json:"spaceId"`
	OwnerUserID       string               `json:"ownerUserId"`
	Title             string               `json:"title"`
	Description       string               `json:"description"`
	Question          string               `json:"question"`
	ChoiceMode        string               `json:"choiceMode"`
	MinSelections     int                  `json:"minSelections"`
	MaxSelections     int                  `json:"maxSelections"`
	AllowVoteChange   bool                 `json:"allowVoteChange"`
	ResultVisibility  string               `json:"resultVisibility"`
	DeliveryPolicy    string               `json:"deliveryPolicy"`
	Status            string               `json:"status"`
	Deadline          *string              `json:"deadline"`
	Revision          int64                `json:"revision"`
	Options           []SolicitationOption `json:"options"`
	Counts            map[string]int64     `json:"counts"`
	SelectedOptionIDs []string             `json:"selectedOptionIds"`
	VoteCount         *int64               `json:"voteCount"`
	OwnerProjection   *OwnerProjection     `json:"ownerProjection"`
	CardPayload       map[string]any       `json:"cardPayload"`
	CreatedAt         string               `json:"createdAt"`
	UpdatedAt         string               `json:"updatedAt"`
	PublishedAt       *string              `json:"publishedAt"`
	ClosedAt          *string              `json:"closedAt"`
	WithdrawnAt       *string              `json:"withdrawnAt"`
}

type SolicitationVote struct {
	ID               string   `json:"id"`
	VoterUserID      string   `json:"voterUserId"`
	VoterDisplayName string   `json:"voterDisplayName"`
	VoterGitHubLogin string   `json:"voterGithubLogin"`
	OptionIDs        []string `json:"optionIds"`
	Revision         int64    `json:"revision"`
	CreatedAt        string   `json:"createdAt"`
	UpdatedAt        string   `json:"updatedAt"`
}

type SolicitationDelivery struct {
	ID                   string  `json:"id"`
	RecipientUserID      string  `json:"recipientUserId"`
	RecipientDisplayName string  `json:"recipientDisplayName"`
	RecipientGitHubLogin string  `json:"recipientGithubLogin"`
	Status               string  `json:"status"`
	AttemptCount         int     `json:"attemptCount"`
	LastErrorCode        *string `json:"lastErrorCode"`
	DeliveredAt          *string `json:"deliveredAt"`
	CreatedAt            string  `json:"createdAt"`
	UpdatedAt            string  `json:"updatedAt"`
}

type DeliveryProjection struct {
	Type            string `json:"type"`
	DeliveryID      string `json:"deliveryId"`
	SolicitationID  string `json:"solicitationId"`
	PublicID        string `json:"publicId"`
	RecipientUserID string `json:"recipientUserId"`
	Status          string `json:"status"`
	Revision        int64  `json:"revision"`
}

type CardBlock struct {
	Type          string `json:"type"`
	CardID        string `json:"cardId"`
	CardType      string `json:"cardType"`
	SchemaVersion int    `json:"schemaVersion"`
	FallbackText  string `json:"fallbackText"`
}

type CardProjection struct {
	Block   CardBlock      `json:"block"`
	Payload map[string]any `json:"payload"`
}

// CreateInputPresence carries JSON presence information that Go scalar zero
// values cannot preserve. A false bit means the field was omitted (or was a
// nullish Node value whose behavior is the same as omission); a true bit
// means the transport supplied the corresponding scalar, including an empty
// string or numeric zero. The legacy scalar fields remain usable for callers
// that already provide non-zero values.
type CreateInputPresence struct {
	Description      bool
	Detail           bool
	ChoiceMode       bool
	MinSelections    bool
	MaxSelections    bool
	ResultVisibility bool
	DeliveryPolicy   bool
	Deadline         bool
}

type CreateInput struct {
	ActorID          string
	SpaceID          string
	Title            string
	Description      string
	Detail           string
	Question         string
	Options          []string
	ChoiceMode       string
	MinSelections    int
	MaxSelections    int
	AllowVoteChange  *bool
	ResultVisibility string
	DeliveryPolicy   string
	Deadline         string
	IdempotencyKey   string
	Meta             auth.RequestMeta
	Presence         CreateInputPresence
}

type GetInput struct {
	ActorID        string
	SpaceID        string
	PublicID       string
	ConversationID string
	Meta           auth.RequestMeta
}

type ListInput struct {
	ActorID        string
	SpaceID        string
	Status         string
	Limit          int
	LimitPresent   bool
	ConversationID string
	Meta           auth.RequestMeta
}

type TransitionInput struct {
	ActorID                 string
	SpaceID                 string
	PublicID                string
	ExpectedRevision        int64
	ExpectedRevisionPresent bool
	IdempotencyKey          string
	ConversationID          string
	Meta                    auth.RequestMeta
}

type VoteInput struct {
	ActorID                 string
	SpaceID                 string
	PublicID                string
	OptionIDs               []string
	SelectedOptionIDs       []string
	ExpectedRevision        int64
	ExpectedRevisionPresent bool
	IdempotencyKey          string
	ConversationID          string
	Meta                    auth.RequestMeta
}

type VotesInput struct {
	ActorID        string
	SpaceID        string
	PublicID       string
	ConversationID string
	Meta           auth.RequestMeta
}

type DeliveriesInput struct {
	ActorID        string
	SpaceID        string
	PublicID       string
	ConversationID string
	Meta           auth.RequestMeta
}

type ProjectDeliveryInput struct {
	SpaceID    string
	DeliveryID string
}

type SolicitationListQuery struct {
	SpaceID string
	ActorID string
	Status  string
	Limit   int
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
	Meta             auth.RequestMeta
	CreatedAt        time.Time
}

type ReadRepository interface {
	LookupActor(context.Context, string, string) (*auth.Actor, error)
	GetSolicitationByPublicID(context.Context, string, string) (*SolicitationRecord, error)
	GetSolicitationByID(context.Context, string, string) (*SolicitationRecord, error)
	ListSolicitations(context.Context, SolicitationListQuery) ([]SolicitationRecord, error)
	ListOptions(context.Context, string) ([]SolicitationOptionRecord, error)
	ListVotes(context.Context, string) ([]VoteRecord, error)
	GetVote(context.Context, string, string) (*VoteRecord, error)
	ListDeliveries(context.Context, string) ([]DeliveryRecord, error)
	DeliverySummary(context.Context, string) (DeliverySummary, error)
	GetIdempotency(context.Context, string, string, string, string) (*IdempotencyRecord, error)
	GetDelivery(context.Context, string, string) (*DeliveryRecord, error)
}

type Repository interface {
	ReadRepository
	WithTx(context.Context, func(Tx) error) error
}

type Tx interface {
	ReadRepository
	ConversationAccess
	Lock(context.Context, string) error
	AllocateSequence(context.Context, string, int) (int, error)
	InsertSolicitation(context.Context, SolicitationRecord) error
	InsertOption(context.Context, SolicitationOptionRecord) error
	InsertIdempotency(context.Context, IdempotencyRecord) (bool, error)
	UpdateIdempotencyResult(context.Context, string, string, string, string, []byte) error
	UpdateSolicitationStateCAS(context.Context, string, int64, string, int64, time.Time, *time.Time, *time.Time, *time.Time) (bool, error)
	InsertVote(context.Context, VoteRecord) error
	UpdateVote(context.Context, VoteRecord) (bool, error)
	InsertDeliveryRows(context.Context, string, string, time.Time) error
	WriteAudit(context.Context, AuditInput) error
	WriteEvent(context.Context, EventInput) (EventRecord, error)
}

var _ Repository = (*PGRepository)(nil)
