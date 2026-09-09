package automation

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/releases"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/solicitations"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/interactions"
)

const (
	CommandVersion  = 1
	WorkflowVersion = 1
	EchoBotUserID   = "usr_system_echo"

	PublishWorkflowType     = "echo.publish"
	RequirementWorkflowType = "echo.requirement"
)

// CommandNames is the source-of-truth command inventory copied from the
// active Node Echo runtime. Keep route/resource names such as "requirements"
// and "solicitations" out of this list: they are not bot commands.
var CommandNames = [...]string{
	"help",
	"cancel",
	"publish",
	"release",
	"need",
	"feedback",
	"list",
	"view",
	"collect",
	"implement",
	"reject",
}

// SharedTxProvider is implemented by composition on the concrete interaction
// transaction. Every returned view must use that same underlying PG tx; none
// of the methods may acquire a pool connection or commit independently.
// WithEchoSavepoint is required for the publish workflow because its Node
// behavior is create-then-publish but the two domain writes must commit as one
// business unit.
type SharedTxProvider interface {
	RequirementTransaction() requirements.Tx
	SolicitationTransaction() solicitations.Tx
	ReleaseTransaction() releases.Tx
	WithEchoSavepoint(context.Context, string, func(context.Context) error) error
}

// RequirementsPort is deliberately narrow. Read methods retain the existing
// service read contract; mutation methods are the caller-owned transaction
// variants and must never fall back to Submit/Transition.
type RequirementsPort interface {
	Get(context.Context, requirements.GetInput) (*requirements.Requirement, error)
	ListPage(context.Context, requirements.ListInput) (requirements.RequirementPage, error)
	SubmitInTx(context.Context, requirements.Tx, requirements.SubmitInput) (*requirements.Requirement, error)
	TransitionInTx(context.Context, requirements.Tx, requirements.TransitionInput) (*requirements.Requirement, error)
}

// SolicitationMutationPort is the typed seam that the solicitation owner must
// provide. The current domain service exposes Create/Publish pool methods;
// automation intentionally does not call them because that would split the
// workflow transaction.
type SolicitationMutationPort interface {
	CreateInTx(context.Context, solicitations.Tx, solicitations.CreateInput) (*solicitations.Solicitation, error)
	PublishInTx(context.Context, solicitations.Tx, solicitations.TransitionInput) (*solicitations.Solicitation, error)
}

type ReleasePort interface {
	PublishInTx(context.Context, releases.Tx, releases.PublishInput) (*releases.PublicationSummary, error)
}

// WorkflowControlPort adapts the generic interaction service's cancellation
// operation onto its caller-owned transaction. The command is not allowed to
// invoke a standalone CancelWorkflow method from inside Execute.
type WorkflowControlPort interface {
	CancelWorkflowInTx(context.Context, interactions.Tx, string, interactions.CancelWorkflowInput) (interactions.Workflow, error)
}

type Options struct {
	Requirements    RequirementsPort
	Solicitations   SolicitationMutationPort
	Releases        ReleasePort
	WorkflowControl WorkflowControlPort
	Now             func() time.Time
}

// SavepointFailure marks failure to establish, roll back, or release the
// caller-owned savepoint. A parent adapter must use this wrapper for those
// infrastructure failures; callback/domain errors must be returned unchanged.
type SavepointFailure struct{ Err error }

// InteractionInfrastructureFailure keeps savepoint cleanup failures on the
// outer transaction rollback path without importing automation from the
// generic interactions package.
func (*SavepointFailure) InteractionInfrastructureFailure() {}

func (e *SavepointFailure) Error() string {
	if e == nil || e.Err == nil {
		return "echo automation savepoint failed"
	}
	return e.Err.Error()
}

func (e *SavepointFailure) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

var ErrTransactionBridgeUnavailable = errors.New("echo automation transaction bridge is unavailable")

func bridgeUnavailable(operation string) error {
	return fmt.Errorf("%w: %s", ErrTransactionBridgeUnavailable, operation)
}

func nowUTC(options Options) time.Time {
	if options.Now != nil {
		value := options.Now()
		if !value.IsZero() {
			return value.UTC().Truncate(time.Millisecond)
		}
	}
	return time.Now().UTC().Truncate(time.Millisecond)
}

func commandNames() []string {
	result := make([]string, 0, len(CommandNames))
	for _, name := range CommandNames {
		result = append(result, "/"+name)
	}
	return result
}
