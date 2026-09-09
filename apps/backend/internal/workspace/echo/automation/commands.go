package automation

import (
	"context"
	"errors"
	"strings"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/releases"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/interactions"
)

func commandContexts() []interactions.CommandContext {
	return []interactions.CommandContext{interactions.CommandContextDirect, interactions.CommandContextMention}
}

func commandDefinitions(options Options) []interactions.CommandDefinition {
	return []interactions.CommandDefinition{
		{
			Name:           "help",
			Version:        CommandVersion,
			Contexts:       commandContexts(),
			ParseArguments: parseEmptyArguments,
			Execute: func(context.Context, interactions.CommandExecution) (interactions.CommandResult, error) {
				return interactions.CommandResult{Result: map[string]any{
					"type":      "help",
					"botUserId": EchoBotUserID,
					"commands":  commandNames(),
				}}, nil
			},
		},
		{
			Name:           "cancel",
			Version:        CommandVersion,
			Contexts:       commandContexts(),
			ParseArguments: parseWorkflowIDArguments,
			Execute:        cancelCommand(options),
		},
		{
			Name:           "publish",
			Version:        CommandVersion,
			Contexts:       commandContexts(),
			ParseArguments: parsePublishArguments,
			Authorize:      ownerOnly,
			Execute: func(_ context.Context, _ interactions.CommandExecution) (interactions.CommandResult, error) {
				return interactions.CommandResult{Result: map[string]any{
					"type":         "workflow.start",
					"workflowType": PublishWorkflowType,
					"version":      WorkflowVersion,
					"input":        map[string]any{},
				}}, nil
			},
		},
		{
			Name:           "release",
			Version:        CommandVersion,
			Contexts:       commandContexts(),
			ParseArguments: parseReleaseArguments,
			Authorize:      ownerOnly,
			Execute:        releaseCommand(options),
		},
		{
			Name:           "need",
			Version:        CommandVersion,
			Contexts:       commandContexts(),
			ParseArguments: parseRequirementWorkflowArguments,
			Authorize:      nonAuditor,
			Execute:        requirementWorkflowStart(""),
		},
		{
			Name:           "feedback",
			Version:        CommandVersion,
			Contexts:       commandContexts(),
			ParseArguments: parseFeedbackArguments,
			Authorize:      nonAuditor,
			Execute:        requirementWorkflowStart("problem"),
		},
		{
			Name:           "list",
			Version:        CommandVersion,
			Contexts:       commandContexts(),
			ParseArguments: parseListArguments,
			Execute:        listRequirementsCommand(options),
		},
		{
			Name:           "view",
			Version:        CommandVersion,
			Contexts:       commandContexts(),
			ParseArguments: parseRequirementIDArguments,
			Execute:        viewRequirementCommand(options),
		},
		{
			Name:           "collect",
			Version:        CommandVersion,
			Contexts:       commandContexts(),
			ParseArguments: parseRequirementIDArguments,
			Authorize:      ownerOnly,
			Execute:        transitionRequirementCommand(options, requirementTransition{Phase: "formal", Status: "planned"}),
		},
		{
			Name:           "implement",
			Version:        CommandVersion,
			Contexts:       commandContexts(),
			ParseArguments: parseRequirementIDArguments,
			Authorize:      ownerOnly,
			Execute:        transitionRequirementCommand(options, requirementTransition{Phase: "formal", Status: "delivered"}),
		},
		{
			Name:           "reject",
			Version:        CommandVersion,
			Contexts:       commandContexts(),
			ParseArguments: parseRejectArguments,
			Authorize:      ownerOnly,
			Execute:        transitionRequirementCommand(options, requirementTransition{Phase: "archived", Status: "archived", ArchiveOutcome: "rejected"}),
		},
	}
}

func ownerOnly(_ context.Context, authorization interactions.CommandAuthorization) (bool, error) {
	return authorization.Actor != nil && authorization.Actor.Role == "owner", nil
}

func nonAuditor(_ context.Context, authorization interactions.CommandAuthorization) (bool, error) {
	return authorization.Actor != nil && authorization.Actor.Role != "auditor", nil
}

func requirementWorkflowStart(forceType string) func(context.Context, interactions.CommandExecution) (interactions.CommandResult, error) {
	return func(_ context.Context, execution interactions.CommandExecution) (interactions.CommandResult, error) {
		arguments, ok := execution.Arguments.(map[string]any)
		if !ok {
			return interactions.CommandResult{}, commandArgumentsError("需求引导参数无效")
		}
		input := cloneMap(arguments)
		if forceType != "" {
			input["type"] = forceType
		}
		return interactions.CommandResult{Result: map[string]any{
			"type":         "workflow.start",
			"workflowType": RequirementWorkflowType,
			"version":      WorkflowVersion,
			"input":        input,
		}}, nil
	}
}

func cancelCommand(options Options) func(context.Context, interactions.CommandExecution) (interactions.CommandResult, error) {
	return func(ctx context.Context, execution interactions.CommandExecution) (interactions.CommandResult, error) {
		control, err := requireWorkflowControl(options)
		if err != nil {
			return interactions.CommandResult{}, err
		}
		provider, err := requireSharedProvider(execution.Tx)
		if err != nil {
			return interactions.CommandResult{}, err
		}
		arguments, ok := execution.Arguments.(WorkflowIDArguments)
		if !ok {
			return interactions.CommandResult{}, commandArgumentsError("工作流参数无效")
		}
		if err := ensureActor(execution.Actor); err != nil {
			return interactions.CommandResult{}, err
		}
		input := interactions.CancelWorkflowInput{
			WorkflowID:     stringPointerValue(arguments.WorkflowID),
			SpaceID:        execution.Context.SpaceID,
			ConversationID: execution.Context.ID,
			BotUserID:      execution.BotUserID,
			Request:        execution.Request,
		}
		var workflow interactions.Workflow
		savepointErr := provider.WithEchoSavepoint(ctx, automationSavepointName("command-cancel:"+execution.ClientInvocationID, 1), func(actionCtx context.Context) error {
			var callErr error
			workflow, callErr = control.CancelWorkflowInTx(actionCtx, execution.Tx, execution.Actor.ID, input)
			if callErr != nil {
				return callErr
			}
			if strings.TrimSpace(workflow.ID) == "" || workflow.Revision < 1 {
				return invalidResult("工作流取消未返回有效结果")
			}
			return nil
		})
		if savepointErr != nil {
			var savepointFailure *SavepointFailure
			if errors.As(savepointErr, &savepointFailure) {
				return interactions.CommandResult{}, savepointErr
			}
			if marker, ok := asInteractionRejection(savepointErr); ok {
				if auditErr := preserveInteractionRejection(ctx, execution.Tx, execution.Actor, execution.Request.Meta, execution.Context.SpaceID, "workflow.cancel", marker, nowUTC(options)); auditErr != nil {
					return interactions.CommandResult{}, wrapInfrastructure("preserve workflow rejection audit", auditErr)
				}
				return interactions.CommandResult{}, publicDomainError(marker.Err)
			}
			return interactions.CommandResult{}, publicDomainError(savepointErr)
		}
		return interactions.CommandResult{Result: map[string]any{
			"type":       "workflow.cancelled",
			"workflowId": workflow.ID,
			"status":     workflow.Status,
			"revision":   workflow.Revision,
			"cancelled":  true,
		}}, nil
	}
}

func releaseCommand(options Options) func(context.Context, interactions.CommandExecution) (interactions.CommandResult, error) {
	return func(ctx context.Context, execution interactions.CommandExecution) (interactions.CommandResult, error) {
		service, err := requireReleases(options)
		if err != nil {
			return interactions.CommandResult{}, err
		}
		provider, err := requireSharedProvider(execution.Tx)
		if err != nil {
			return interactions.CommandResult{}, err
		}
		tx, err := requireReleaseTransaction(provider)
		if err != nil {
			return interactions.CommandResult{}, err
		}
		arguments, ok := execution.Arguments.(ReleaseArguments)
		if !ok {
			return interactions.CommandResult{}, commandArgumentsError("版本参数无效")
		}
		if err := ensureActor(execution.Actor); err != nil {
			return interactions.CommandResult{}, err
		}
		input := releases.PublishInput{
			ActorID: execution.Actor.ID,
			SpaceID: execution.Context.SpaceID,
			Version: arguments.Version,
			Meta:    execution.Request.Meta,
		}
		var publication *releases.PublicationSummary
		savepointErr := provider.WithEchoSavepoint(ctx, automationSavepointName("command-release:"+execution.ClientInvocationID, 1), func(actionCtx context.Context) error {
			var publishErr error
			publication, publishErr = service.PublishInTx(actionCtx, tx, input)
			if publishErr != nil {
				return publishErr
			}
			if err := validatePublication(publication); err != nil {
				return err
			}
			return nil
		})
		if savepointErr != nil {
			var savepointFailure *SavepointFailure
			if errors.As(savepointErr, &savepointFailure) {
				return interactions.CommandResult{}, savepointErr
			}
			if marker, ok := asReleaseRejection(savepointErr); ok {
				if auditErr := preserveReleaseRejection(ctx, tx, execution.Actor, execution.Request.Meta, execution.Context.SpaceID, "echo.release.publish", marker, nowUTC(options)); auditErr != nil {
					return interactions.CommandResult{}, wrapInfrastructure("preserve release rejection audit", auditErr)
				}
				return interactions.CommandResult{}, publicDomainError(marker.Err)
			}
			return interactions.CommandResult{}, publicDomainError(savepointErr)
		}
		return interactions.CommandResult{Result: releaseResult(publication)}, nil
	}
}

func listRequirementsCommand(options Options) func(context.Context, interactions.CommandExecution) (interactions.CommandResult, error) {
	return func(ctx context.Context, execution interactions.CommandExecution) (interactions.CommandResult, error) {
		service, err := requireRequirements(options)
		if err != nil {
			return interactions.CommandResult{}, err
		}
		arguments, ok := execution.Arguments.(ListArguments)
		if !ok {
			return interactions.CommandResult{}, commandArgumentsError("列表筛选参数无效")
		}
		if err := ensureActor(execution.Actor); err != nil {
			return interactions.CommandResult{}, err
		}
		page, listErr := service.ListPage(ctx, requirements.ListInput{
			ActorID:        execution.Actor.ID,
			SpaceID:        execution.Context.SpaceID,
			Phase:          arguments.Phase,
			Status:         arguments.Status,
			ArchiveOutcome: arguments.ArchiveOutcome,
			Meta:           execution.Request.Meta,
		})
		if listErr != nil {
			return interactions.CommandResult{}, publicDomainError(listErr)
		}
		return interactions.CommandResult{Result: map[string]any{
			"type":     "requirement-list",
			"items":    safeRequirementItems(page.Items),
			"total":    page.Total,
			"pageInfo": page.PageInfo,
		}}, nil
	}
}

func viewRequirementCommand(options Options) func(context.Context, interactions.CommandExecution) (interactions.CommandResult, error) {
	return func(ctx context.Context, execution interactions.CommandExecution) (interactions.CommandResult, error) {
		service, err := requireRequirements(options)
		if err != nil {
			return interactions.CommandResult{}, err
		}
		arguments, ok := execution.Arguments.(RequirementIDArguments)
		if !ok {
			return interactions.CommandResult{}, commandArgumentsError("需要有效的需求编号")
		}
		if err := ensureActor(execution.Actor); err != nil {
			return interactions.CommandResult{}, err
		}
		result, getErr := service.Get(ctx, requirements.GetInput{ActorID: execution.Actor.ID, SpaceID: execution.Context.SpaceID, PublicID: arguments.PublicID, Meta: execution.Request.Meta})
		if getErr != nil {
			return interactions.CommandResult{}, publicDomainError(getErr)
		}
		if result == nil {
			return interactions.CommandResult{}, interactions.NewError(requirements.CodeRequirementNotFound, requirements.MessageRequirementNotFound, 404)
		}
		return interactions.CommandResult{Result: map[string]any{"type": "requirement", "requirement": result}}, nil
	}
}

type requirementTransition struct {
	Phase          string
	Status         string
	ArchiveOutcome string
}

func transitionRequirementCommand(options Options, target requirementTransition) func(context.Context, interactions.CommandExecution) (interactions.CommandResult, error) {
	return func(ctx context.Context, execution interactions.CommandExecution) (interactions.CommandResult, error) {
		service, err := requireRequirements(options)
		if err != nil {
			return interactions.CommandResult{}, err
		}
		provider, err := requireSharedProvider(execution.Tx)
		if err != nil {
			return interactions.CommandResult{}, err
		}
		tx, err := requireRequirementTransaction(provider)
		if err != nil {
			return interactions.CommandResult{}, err
		}
		if err := ensureActor(execution.Actor); err != nil {
			return interactions.CommandResult{}, err
		}
		var publicID string
		var response *string
		switch arguments := execution.Arguments.(type) {
		case RequirementIDArguments:
			publicID = arguments.PublicID
		case RejectArguments:
			publicID = arguments.PublicID
			response = arguments.Response
		default:
			return interactions.CommandResult{}, commandArgumentsError("需求参数无效")
		}
		current, getErr := service.Get(ctx, requirements.GetInput{ActorID: execution.Actor.ID, SpaceID: execution.Context.SpaceID, PublicID: publicID, Meta: execution.Request.Meta})
		if getErr != nil {
			return interactions.CommandResult{}, publicDomainError(getErr)
		}
		if current == nil {
			return interactions.CommandResult{}, interactions.NewError(requirements.CodeRequirementNotFound, requirements.MessageRequirementNotFound, 404)
		}
		input := requirements.TransitionInput{
			ActorID:          execution.Actor.ID,
			SpaceID:          execution.Context.SpaceID,
			PublicID:         publicID,
			ToPhase:          target.Phase,
			ToStatus:         target.Status,
			ArchiveOutcome:   target.ArchiveOutcome,
			ExpectedRevision: current.Revision,
			IdempotencyKey:   execution.ClientInvocationID,
			Meta:             execution.Request.Meta,
		}
		if response != nil {
			input.Response = *response
			input.ResponseSet = true
		}
		var result *requirements.Requirement
		savepointErr := provider.WithEchoSavepoint(ctx, automationSavepointName("command-requirement:"+execution.ClientInvocationID, 1), func(actionCtx context.Context) error {
			var transitionErr error
			result, transitionErr = service.TransitionInTx(actionCtx, tx, input)
			if transitionErr != nil {
				return transitionErr
			}
			return validateRequirement(result)
		})
		if savepointErr != nil {
			var savepointFailure *SavepointFailure
			if errors.As(savepointErr, &savepointFailure) {
				return interactions.CommandResult{}, savepointErr
			}
			if marker, ok := asRequirementRejection(savepointErr); ok {
				if auditErr := preserveRequirementRejection(ctx, tx, execution.Actor, execution.Request.Meta, execution.Context.SpaceID, "echo.requirement.transition", marker, nowUTC(options)); auditErr != nil {
					return interactions.CommandResult{}, wrapInfrastructure("preserve requirement rejection audit", auditErr)
				}
				return interactions.CommandResult{}, publicDomainError(marker.Err)
			}
			return interactions.CommandResult{}, publicDomainError(savepointErr)
		}
		return interactions.CommandResult{Result: map[string]any{"type": "requirement-transition", "publicId": result.PublicID, "state": result.State, "phase": result.Phase, "status": result.Status, "archiveOutcome": result.ArchiveOutcome, "duplicateOfPublicId": result.DuplicateOfPublicID, "revision": result.Revision}}, nil
	}
}

func releaseResult(publication *releases.PublicationSummary) map[string]any {
	pending := publication.RecipientCount - publication.SentCount - publication.FailedCount - publication.SkippedCount
	if pending < 0 {
		pending = 0
	}
	return map[string]any{
		"type":           "release-published",
		"version":        publication.Version,
		"title":          publication.Title,
		"recipientCount": publication.RecipientCount,
		"sentCount":      publication.SentCount,
		"failedCount":    publication.FailedCount,
		"skippedCount":   publication.SkippedCount,
		"pendingCount":   pending,
		"replayed":       publication.Replayed,
	}
}

func validatePublication(publication *releases.PublicationSummary) error {
	if publication == nil || strings.TrimSpace(publication.Version) == "" {
		return invalidResult("版本发布未返回有效结果")
	}
	return nil
}

func safeRequirementItems(items []requirements.Requirement) []map[string]any {
	result := make([]map[string]any, 0, len(items))
	for _, item := range items {
		result = append(result, requirementSummary(&item))
	}
	return result
}

func requirementSummary(item *requirements.Requirement) map[string]any {
	if item == nil {
		return map[string]any{}
	}
	return map[string]any{
		"publicId":            item.PublicID,
		"state":               item.State,
		"phase":               item.Phase,
		"status":              item.Status,
		"archiveOutcome":      item.ArchiveOutcome,
		"duplicateOfPublicId": item.DuplicateOfPublicID,
		"revision":            item.Revision,
	}
}

func validateRequirement(requirement *requirements.Requirement) error {
	if requirement == nil || strings.TrimSpace(requirement.PublicID) == "" ||
		strings.TrimSpace(requirement.State) == "" || strings.TrimSpace(requirement.Phase) == "" ||
		strings.TrimSpace(requirement.Status) == "" || requirement.Revision < 1 {
		return invalidResult("需求操作未返回有效结果")
	}
	return nil
}

func stringPointerValue(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func cloneMap(input map[string]any) map[string]any {
	result := make(map[string]any, len(input))
	for key, value := range input {
		result[key] = value
	}
	return result
}
