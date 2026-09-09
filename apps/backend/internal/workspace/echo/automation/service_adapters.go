package automation

import (
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/releases"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/solicitations"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/interactions"
)

// OptionsForServices is the composition adapter for the accepted concrete Go
// services. All mutation ports are the services' caller-owned InTx methods;
// this helper intentionally has no fallback to their pool transaction APIs.
func OptionsForServices(
	requirementService *requirements.Service,
	solicitationService *solicitations.Service,
	releaseService *releases.Service,
	workflowService *interactions.Service,
	now func() time.Time,
) Options {
	return Options{
		Requirements:    requirementService,
		Solicitations:   solicitationService,
		Releases:        releaseService,
		WorkflowControl: workflowService,
		Now:             now,
	}
}

var _ RequirementsPort = (*requirements.Service)(nil)
var _ SolicitationMutationPort = (*solicitations.Service)(nil)
var _ ReleasePort = (*releases.Service)(nil)
var _ WorkflowControlPort = (*interactions.Service)(nil)
