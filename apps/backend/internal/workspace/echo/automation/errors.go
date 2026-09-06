package automation

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/releases"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/solicitations"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/interactions"
)

func commandArgumentsError(message string) error {
	return interactions.NewError("command.arguments_invalid", message, 400)
}

func workflowStateError(message string) error {
	return interactions.NewError("workflow.state_invalid", message, 400)
}

func domainUnavailable(message string) error {
	return interactions.NewError("echo.unavailable", message, 503)
}

func invalidResult(message string) error {
	return interactions.NewError("echo.invalid_result", message, 500)
}

// publicDomainError preserves the domain's public code/status while adapting
// it to interactions' error type. Without this adapter the generic interaction
// service would collapse every Echo validation/rejection into workflow.failed.
func publicDomainError(err error) error {
	if err == nil {
		return nil
	}
	if hasInfrastructureLeaf(err, 0) {
		return err
	}
	var interactionErr *interactions.Error
	if errors.As(err, &interactionErr) {
		return interactionErr
	}
	var requirementErr *requirements.Error
	if errors.As(err, &requirementErr) && requirementErr != nil {
		return interactions.NewError(requirementErr.Code, requirementErr.Message, publicStatus(requirementErr.StatusCode))
	}
	var solicitationErr *solicitations.Error
	if errors.As(err, &solicitationErr) && solicitationErr != nil {
		return interactions.NewError(solicitationErr.Code, solicitationErr.Message, publicStatus(solicitationErr.StatusCode))
	}
	var releaseErr *releases.Error
	if errors.As(err, &releaseErr) && releaseErr != nil {
		return interactions.NewError(releaseErr.Code, releaseErr.Message, publicStatus(releaseErr.StatusCode))
	}
	return err
}

func publicStatus(value int) int {
	if value < 100 || value > 599 {
		return 500
	}
	return value
}

// hasInfrastructureLeaf runs before publicDomainError converts a domain
// error. errors.As on a joined error can find a valid 4xx domain leaf while a
// sibling is an unknown or infrastructure failure; conversion must never
// erase that sibling. Domain packages are intentionally kept out of the
// generic interactions package, so this trusted adapter supplies their
// expected 4xx shapes here.
func hasInfrastructureLeaf(err error, depth int) bool {
	if err == nil {
		return false
	}
	if depth > 64 || err == context.Canceled || err == context.DeadlineExceeded {
		return true
	}
	if _, ok := err.(interactions.InfrastructureMarker); ok {
		return true
	}
	switch typed := err.(type) {
	case *interactions.Error:
		return interactions.IsInfrastructureFailure(typed)
	case *requirements.Error:
		if typed == nil {
			return true
		}
		return domainErrorHasInfrastructureCause(typed.StatusCode, typed.Cause, depth)
	case *solicitations.Error:
		if typed == nil {
			return true
		}
		return domainErrorHasInfrastructureCause(typed.StatusCode, typed.Cause, depth)
	case *releases.Error:
		if typed == nil {
			return true
		}
		return domainErrorHasInfrastructureCause(typed.StatusCode, typed.Cause, depth)
	case *cards.CardValidationError:
		return false
	}
	if many, ok := err.(interface{ Unwrap() []error }); ok {
		children := many.Unwrap()
		if len(children) == 0 {
			return true
		}
		for _, child := range children {
			if hasInfrastructureLeaf(child, depth+1) {
				return true
			}
		}
		return false
	}
	if one, ok := err.(interface{ Unwrap() error }); ok {
		child := one.Unwrap()
		return child == nil || hasInfrastructureLeaf(child, depth+1)
	}
	return true
}

func domainErrorHasInfrastructureCause(status int, cause error, depth int) bool {
	if status < 400 || status >= 500 {
		return true
	}
	return cause != nil && hasInfrastructureLeaf(cause, depth+1)
}

func asSolicitationRejection(err error) (*solicitations.TransactionRejection, bool) {
	if hasInfrastructureLeaf(err, 0) {
		return nil, false
	}
	var marker *solicitations.TransactionRejection
	if !errors.As(err, &marker) || marker == nil || marker.Err == nil {
		return nil, false
	}
	return marker, true
}

func asRequirementRejection(err error) (*requirements.TransactionRejection, bool) {
	if hasInfrastructureLeaf(err, 0) {
		return nil, false
	}
	var marker *requirements.TransactionRejection
	if !errors.As(err, &marker) || marker == nil || marker.Err == nil {
		return nil, false
	}
	return marker, true
}

func asReleaseRejection(err error) (*releases.TransactionRejection, bool) {
	if hasInfrastructureLeaf(err, 0) {
		return nil, false
	}
	var marker *releases.TransactionRejection
	if !errors.As(err, &marker) || marker == nil || marker.Err == nil {
		return nil, false
	}
	return marker, true
}

func asInteractionRejection(err error) (*interactions.TransactionRejection, bool) {
	if hasInfrastructureLeaf(err, 0) {
		return nil, false
	}
	var marker *interactions.TransactionRejection
	if !errors.As(err, &marker) || marker == nil || marker.Err == nil {
		return nil, false
	}
	return marker, true
}

func requireSharedProvider(tx interactions.Tx) (SharedTxProvider, error) {
	provider, ok := tx.(SharedTxProvider)
	if !ok || provider == nil {
		return nil, bridgeUnavailable("shared Echo transaction provider")
	}
	return provider, nil
}

func requireRequirements(options Options) (RequirementsPort, error) {
	if options.Requirements == nil {
		return nil, domainUnavailable("需求服务尚未初始化")
	}
	return options.Requirements, nil
}

func requireSolicitations(options Options) (SolicitationMutationPort, error) {
	if options.Solicitations == nil {
		return nil, domainUnavailable("征集事务服务尚未接线")
	}
	return options.Solicitations, nil
}

func requireReleases(options Options) (ReleasePort, error) {
	if options.Releases == nil {
		return nil, domainUnavailable("版本发布服务尚未初始化")
	}
	return options.Releases, nil
}

func requireWorkflowControl(options Options) (WorkflowControlPort, error) {
	if options.WorkflowControl == nil {
		return nil, domainUnavailable("工作流取消事务桥尚未接线")
	}
	return options.WorkflowControl, nil
}

func requireRequirementTransaction(provider SharedTxProvider) (requirements.Tx, error) {
	tx := provider.RequirementTransaction()
	if tx == nil {
		return nil, bridgeUnavailable("requirement transaction")
	}
	return tx, nil
}

func requireSolicitationTransaction(provider SharedTxProvider) (solicitations.Tx, error) {
	tx := provider.SolicitationTransaction()
	if tx == nil {
		return nil, bridgeUnavailable("solicitation transaction")
	}
	return tx, nil
}

func requireReleaseTransaction(provider SharedTxProvider) (releases.Tx, error) {
	tx := provider.ReleaseTransaction()
	if tx == nil {
		return nil, bridgeUnavailable("release transaction")
	}
	return tx, nil
}

func preserveRequirementRejection(ctx context.Context, tx requirements.Tx, actor *auth.Actor, meta auth.RequestMeta, spaceID, action string, marker *requirements.TransactionRejection, at time.Time) error {
	if marker == nil || marker.Err == nil {
		return invalidResult("Echo 需求拒绝标记缺失")
	}
	if err := ensureActor(actor); err != nil {
		return err
	}
	reason := marker.Reason
	if reason == "" {
		reason = marker.Err.Code
	}
	return tx.WriteAudit(ctx, requirements.AuditInput{
		SpaceID:          spaceID,
		ActorUserID:      actor.ID,
		ActorGitHubLogin: actor.GitHubLogin,
		Action:           action,
		TargetType:       "echo.requirement",
		TargetID:         marker.TargetID,
		Result:           "rejected",
		Reason:           reason,
		Meta:             meta.Safe(),
		CreatedAt:        at.UTC().Truncate(time.Millisecond),
	})
}

func preserveReleaseRejection(ctx context.Context, tx releases.Tx, actor *auth.Actor, meta auth.RequestMeta, spaceID, action string, marker *releases.TransactionRejection, at time.Time) error {
	if marker == nil || marker.Err == nil {
		return invalidResult("Echo 版本拒绝标记缺失")
	}
	if err := ensureActor(actor); err != nil {
		return err
	}
	reason := marker.Reason
	if reason == "" {
		reason = marker.Err.Code
	}
	return tx.WriteAudit(ctx, releases.AuditInput{
		SpaceID:          spaceID,
		ActorUserID:      actor.ID,
		ActorGitHubLogin: actor.GitHubLogin,
		Action:           action,
		TargetType:       "echo.release",
		TargetID:         marker.TargetID,
		Result:           "rejected",
		Reason:           reason,
		Meta:             meta.Safe(),
		CreatedAt:        at.UTC().Truncate(time.Millisecond),
	})
}

func preserveSolicitationRejection(ctx context.Context, tx solicitations.Tx, actor *auth.Actor, meta auth.RequestMeta, spaceID, action string, marker *solicitations.TransactionRejection, at time.Time) error {
	if marker == nil || marker.Err == nil {
		return invalidResult("Echo 拒绝标记缺失")
	}
	if err := ensureActor(actor); err != nil {
		return err
	}
	// This write deliberately happens after the domain savepoint has rolled
	// back. It keeps only content-free rejection evidence, never draft/event
	// rows from the failed multi-step workflow.
	reason := marker.Reason
	if reason == "" {
		reason = marker.Err.Code
	}
	return tx.WriteAudit(ctx, solicitations.AuditInput{
		SpaceID:          spaceID,
		ActorUserID:      actor.ID,
		ActorGitHubLogin: actor.GitHubLogin,
		Action:           action,
		TargetType:       "echo.solicitation",
		TargetID:         marker.TargetID,
		Result:           "rejected",
		Reason:           reason,
		Meta:             meta.Safe(),
		CreatedAt:        at.UTC().Truncate(time.Millisecond),
	})
}

func preserveInteractionRejection(ctx context.Context, tx interactions.Tx, actor *auth.Actor, meta auth.RequestMeta, spaceID, action string, marker *interactions.TransactionRejection, at time.Time) error {
	if marker == nil || marker.Err == nil {
		return invalidResult("Echo 交互拒绝标记缺失")
	}
	if err := ensureActor(actor); err != nil {
		return err
	}
	reason := marker.Reason
	if reason == "" {
		var domain *interactions.Error
		if errors.As(marker.Err, &domain) && domain != nil {
			reason = domain.Code
		}
	}
	if reason == "" {
		reason = "interaction.rejected"
	}
	meta = meta.Safe()
	return tx.WriteAudit(ctx, interactions.AuditInput{
		SpaceID:          spaceID,
		ActorUserID:      actor.ID,
		ActorGitHubLogin: actor.GitHubLogin,
		Action:           action,
		TargetType:       "workspace.workflow",
		TargetID:         marker.TargetID,
		Result:           "rejected",
		Reason:           reason,
		RequestID:        meta.RequestID,
		IPAddress:        meta.IPAddress,
		UserAgent:        meta.UserAgent,
		CreatedAt:        at.UTC().Truncate(time.Millisecond),
	})
}

func ensureActor(actor *auth.Actor) error {
	if actor == nil || actor.ID == "" {
		return invalidResult("Echo 操作缺少服务端身份")
	}
	return nil
}

func wrapInfrastructure(operation string, err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return fmt.Errorf("%s: %w", operation, err)
}
