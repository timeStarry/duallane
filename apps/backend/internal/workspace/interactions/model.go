package interactions

import (
	"context"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

const (
	DefaultSpaceID           = auth.DefaultSpaceID
	MaxCommandTextCodePoints = 4096
	DefaultWorkflowTTL       = 30 * time.Minute
	MaxWorkflowTTL           = 24 * time.Hour
	RateLimitWindow          = time.Minute
)

type Request struct{ Meta auth.RequestMeta }

type ConversationRecord struct {
	ID      string
	SpaceID string
	Type    string
}

type CommandContext string

const (
	CommandContextDirect  CommandContext = "direct"
	CommandContextMention CommandContext = "mention"
)

type RecognitionContext struct {
	ConversationType string
	BotUserID        string
	MentionedBotIDs  []string
}

type CommandDefinition struct {
	Name           string
	Aliases        []string
	Version        int
	Contexts       []CommandContext
	ParseArguments func(string) (any, error)
	Authorize      func(context.Context, CommandAuthorization) (bool, error)
	Execute        func(context.Context, CommandExecution) (CommandResult, error)
}

type CommandAuthorization struct {
	Actor     *auth.Actor
	Context   ConversationRecord
	BotUserID string
	Arguments any
}
type CommandExecution struct {
	Tx                 Tx
	Actor              *auth.Actor
	Context            ConversationRecord
	BotUserID          string
	Arguments          any
	Request            Request
	ClientInvocationID string
}
type CommandResult struct {
	Result       any
	ResultCardID string
}

type RecognizedCommand struct {
	Type         string
	Name         string
	RawArguments string
	Arguments    any
	Definition   *CommandDefinition
}

type WorkflowDefinition struct {
	Type          string
	Version       int
	Initialize    func(context.Context, WorkflowExecution) (WorkflowResult, error)
	Continue      func(context.Context, WorkflowExecution) (WorkflowResult, error)
	ValidateState func(any) (any, error)
	Authorize     func(context.Context, WorkflowAuthorization) (bool, error)
	Project       func(context.Context, WorkflowProjectionContext) (any, error)
}

type WorkflowAuthorization struct {
	Actor     *auth.Actor
	Context   ConversationRecord
	Operation string
	Workflow  Workflow
	Input     any
}
type WorkflowExecution struct {
	Tx        Tx
	Actor     *auth.Actor
	Context   ConversationRecord
	Workflow  Workflow
	State     any
	Input     any
	BotUserID string
	Request   Request
}
type WorkflowResult struct {
	State  any
	Status string
	Result any
}
type WorkflowProjectionContext struct {
	Actor    *auth.Actor
	Workflow Workflow
	State    any
}

type Workflow struct {
	ID             string  `json:"id"`
	SpaceID        string  `json:"spaceId"`
	ConversationID *string `json:"conversationId"`
	BotUserID      *string `json:"botUserId"`
	Type           string  `json:"type"`
	Version        int     `json:"version"`
	Status         string  `json:"status"`
	Revision       int64   `json:"revision"`
	State          any     `json:"state"`
	ExpiresAt      string  `json:"expiresAt"`
	CreatedAt      string  `json:"createdAt"`
	UpdatedAt      string  `json:"updatedAt"`
}

type WorkflowRecord struct {
	ID                 string
	SpaceID            string
	ConversationID     *string
	ActorUserID        string
	BotUserID          *string
	WorkflowType       string
	WorkflowVersion    int
	StateJSON          []byte
	Status             string
	Revision           int64
	ExpiresAt          time.Time
	CreatedAt          time.Time
	UpdatedAt          time.Time
	ClientInvocationID *string
	StartRequestHash   *string
}

type CommandRunRecord struct {
	ID                 string
	SpaceID            string
	ConversationID     *string
	ActorUserID        string
	BotUserID          *string
	CommandName        string
	CommandVersion     int
	ClientInvocationID string
	RequestHash        string
	ArgumentsJSON      []byte
	Status             string
	ResultCardID       *string
	ResultJSON         []byte
	ErrorCode          string
	CreatedAt          time.Time
	CompletedAt        *time.Time
}

type ExecuteCommandInput struct {
	ActorID            string
	SpaceID            string
	ConversationID     string
	BotUserID          string
	Source             string
	MentionedBotIDs    []string
	ClientInvocationID string
	Request            Request
}

type StartWorkflowInput struct {
	ActorID            string
	SpaceID            string
	ConversationID     string
	BotUserID          string
	Type               string
	Version            int
	Input              any
	TTL                time.Duration
	ClientInvocationID string
	Request            Request
}

type ContinueWorkflowInput struct {
	WorkflowID       string
	ExpectedRevision int64
	Input            any
	Request          Request
}
type CancelWorkflowInput struct {
	WorkflowID     string
	SpaceID        string
	ConversationID string
	BotUserID      string
	Request        Request
}

type CommandOutcome struct {
	OK           bool    `json:"ok"`
	Replayed     bool    `json:"replayed"`
	Result       any     `json:"result"`
	ResultCardID *string `json:"resultCardId"`
}
type WorkflowOutcome struct {
	Workflow Workflow `json:"workflow"`
	Result   any      `json:"result"`
}

type RateLimitInput struct {
	SpaceID         string
	ActorUserID     string
	BotUserID       string
	OperationKey    string
	WindowStartedAt time.Time
	UpdatedAt       time.Time
	Limit           int
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

func publicWorkflow(record *WorkflowRecord, state any) Workflow {
	return Workflow{ID: record.ID, SpaceID: record.SpaceID, ConversationID: record.ConversationID, BotUserID: record.BotUserID, Type: record.WorkflowType, Version: record.WorkflowVersion, Status: record.Status, Revision: record.Revision, State: state, ExpiresAt: formatTimestamp(record.ExpiresAt), CreatedAt: formatTimestamp(record.CreatedAt), UpdatedAt: formatTimestamp(record.UpdatedAt)}
}
func formatTimestamp(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}
func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
