package interactions

import (
	"context"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type ReadRepository interface {
	LookupActor(context.Context, string, string) (*auth.Actor, error)
	GetConversation(context.Context, string, string) (*ConversationRecord, error)
	ConversationMemberActive(context.Context, string, string, string) (bool, error)
	BotMemberActive(context.Context, string, string, string) (bool, error)
	GetCommandRun(context.Context, string, string, string) (*CommandRunRecord, error)
	GetWorkflow(context.Context, string, string) (*WorkflowRecord, error)
	GetWorkflowByInvocation(context.Context, string, string, string) (*WorkflowRecord, error)
	ListActiveWorkflows(context.Context, string, string, string, int) ([]WorkflowRecord, error)
}

type Repository interface {
	ReadRepository
	WithTx(context.Context, func(Tx) error) error
}

type Tx interface {
	ReadRepository
	Lock(context.Context, string) error
	ConsumeRateLimit(context.Context, RateLimitInput) (bool, time.Duration, error)
	InsertCommandRun(context.Context, CommandRunRecord) (*CommandRunRecord, bool, error)
	CompleteCommandRun(context.Context, string, *string, []byte, time.Time) error
	FailCommandRun(context.Context, string, string, time.Time) error
	ExpireWorkflows(context.Context, string, string, string, time.Time) error
	InsertWorkflow(context.Context, WorkflowRecord) (*WorkflowRecord, bool, error)
	UpdateWorkflow(context.Context, string, int64, any, string, time.Time) (*WorkflowRecord, bool, error)
	WriteAudit(context.Context, AuditInput) error
	WriteEvent(context.Context, EventInput) (EventRecord, error)
}

var _ Repository = (*PGRepository)(nil)
