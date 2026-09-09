package carddefinitions

import (
	"context"
	"errors"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/solicitations"
)

type requirementActionTarget struct {
	phase          string
	status         string
	archiveOutcome string
}

var requirementActionTargets = map[string]requirementActionTarget{
	"collect":   {phase: requirements.PhaseFormal, status: requirements.StatusPlanned},
	"start":     {phase: requirements.PhaseFormal, status: requirements.StatusInProgress},
	"progress":  {phase: requirements.PhaseFormal, status: requirements.StatusInProgress},
	"implement": {phase: requirements.PhaseFormal, status: requirements.StatusDelivered},
	"reject":    {phase: requirements.PhaseArchived, status: requirements.StatusArchived, archiveOutcome: requirements.ArchiveRejected},
	"duplicate": {phase: requirements.PhaseArchived, status: requirements.StatusArchived, archiveOutcome: requirements.ArchiveDuplicate},
}

func requirementActions(adapter RequirementCardActionAdapter) map[string]cards.CardAction {
	actions := make(map[string]cards.CardAction, len(requirementActionTargets))
	for actionID, target := range requirementActionTargets {
		id := actionID
		target := target
		actions[id] = cards.CardAction{
			ValidateInput: func(input any) (any, error) {
				object, ok := input.(map[string]any)
				if !ok {
					return nil, invalidActionInput()
				}
				value, err := requirements.ValidateRequirementCardActionInput(id, object)
				return value, adaptValidationError(err)
			},
			Authorize: func(_ context.Context, authorization cards.CardAuthorization) (bool, error) {
				return authorization.Actor != nil && authorization.Actor.Kind == "human" && authorization.Actor.Role == "owner", nil
			},
			Execute: func(ctx context.Context, actionContext cards.CardActionContext) (cards.CardActionResult, error) {
				return executeRequirementAction(ctx, target, adapter, actionContext)
			},
		}
	}
	return actions
}

func executeRequirementAction(ctx context.Context, target requirementActionTarget, adapter RequirementCardActionAdapter, actionContext cards.CardActionContext) (cards.CardActionResult, error) {
	if adapter == nil {
		return cards.CardActionResult{}, actionUnavailable("Echo 需求卡片操作")
	}
	if actionContext.Actor == nil {
		return cards.CardActionResult{}, cards.NewError(cards.CodeAuthRequired, cards.MessageAuthRequired, 401)
	}
	if actionContext.Tx == nil {
		return cards.CardActionResult{}, actionUnavailable("Echo 需求卡片事务")
	}
	payload, ok := actionContext.Payload.(map[string]any)
	if !ok {
		return cards.CardActionResult{}, invalidCardPayload()
	}
	publicID, ok := payload["publicId"].(string)
	if !ok || actorID(publicID) == "" {
		return cards.CardActionResult{}, &cards.CardValidationError{Code: requirements.CodeRequirementIDInvalid, Message: requirements.MessageRequirementIDInvalid}
	}
	// The public Card projection intentionally omits persisted provenance. Read
	// it from the current cards transaction before invoking the domain adapter;
	// otherwise a custom_bot card with an Echo-shaped payload could make an
	// owner's action transition an unrelated requirement.
	if err := validateEchoCardBinding(ctx, actionContext, requirements.CardTypeRequirement, requirements.CardSchemaVersion, ResourceKindRequirement, publicID); err != nil {
		return cards.CardActionResult{}, err
	}
	provider, ok := actionContext.Tx.(RequirementTransactionProvider)
	if !ok || provider == nil {
		return cards.CardActionResult{}, actionUnavailable("Echo 需求卡片事务")
	}
	tx := provider.RequirementTransaction()
	if tx == nil {
		return cards.CardActionResult{}, actionUnavailable("Echo 需求卡片事务")
	}
	input, ok := actionContext.Input.(map[string]any)
	if !ok {
		return cards.CardActionResult{}, invalidActionInput()
	}
	idempotencyKey, ok := input["idempotencyKey"].(string)
	if !ok || actorID(idempotencyKey) == "" {
		return cards.CardActionResult{}, invalidActionInput()
	}
	transition := requirements.TransitionInput{
		ActorID:          actionContext.Actor.ID,
		SpaceID:          actionContext.Card.SpaceID,
		PublicID:         publicID,
		ToPhase:          target.phase,
		ToStatus:         target.status,
		ArchiveOutcome:   target.archiveOutcome,
		ExpectedRevision: actionContext.Card.Revision,
		IdempotencyKey:   idempotencyKey,
		Meta:             actionContext.Request.Meta,
	}
	if response, present := input["response"]; present {
		value, ok := response.(string)
		if !ok {
			return cards.CardActionResult{}, invalidActionInput()
		}
		transition.Response = value
		transition.ResponseSet = true
	}
	if duplicateID, present := input["duplicateOfPublicId"]; present {
		value, ok := duplicateID.(string)
		if !ok {
			return cards.CardActionResult{}, invalidActionInput()
		}
		transition.DuplicateOfPublicID = value
		transition.DuplicateOfPublicIDSet = true
	}
	result, err := adapter.TransitionInTx(ctx, tx, transition)
	if err != nil {
		return cards.CardActionResult{}, err
	}
	if result == nil {
		return cards.CardActionResult{}, errors.New("echo requirement card action returned no result")
	}
	projection, err := adapter.ProjectCardInTx(ctx, tx, requirements.GetInput{
		ActorID:  actionContext.Actor.ID,
		SpaceID:  actionContext.Card.SpaceID,
		PublicID: result.PublicID,
		CardType: actionContext.Card.Block.CardType,
		Meta:     actionContext.Request.Meta,
	})
	if err != nil {
		return cards.CardActionResult{}, err
	}
	if projection == nil {
		return cards.CardActionResult{}, errors.New("echo requirement card projection returned no result")
	}
	// The refreshed CardPayload is used only to update the stored projection.
	// Result is deliberately the domain's safe summary and never contains the
	// requirement body, submitter detail, response, or audit metadata.
	return cards.CardActionResult{
		CardPayload: projection.Payload,
		Result:      requirements.SafeRequirementActionResult(*result),
	}, nil
}

func validateSolicitationCardBinding(ctx context.Context, actionContext cards.CardActionContext) error {
	payload, ok := actionContext.Payload.(map[string]any)
	if !ok {
		return invalidCardPayload()
	}
	publicID, ok := payload["publicId"].(string)
	if !ok || actorID(publicID) == "" {
		return invalidCardPayload()
	}
	return validateEchoCardBinding(ctx, actionContext, solicitations.CardType, solicitations.CardSchemaVersion, ResourceKindSolicitation, publicID)
}

func validateEchoCardBinding(ctx context.Context, actionContext cards.CardActionContext, expectedCardType string, expectedSchemaVersion int, expectedResourceType, resourceID string) error {
	if actionContext.Tx == nil {
		return actionUnavailable("Echo 卡片事务")
	}
	row, err := actionContext.Tx.GetCard(ctx, actionContext.Card.SpaceID, actionContext.Card.ID)
	if err != nil {
		return err
	}
	if row == nil || row.ID != actionContext.Card.ID || row.SpaceID != actionContext.Card.SpaceID ||
		row.CardType != actionContext.Card.Block.CardType || row.SchemaVersion != actionContext.Card.Block.SchemaVersion ||
		row.CardType != expectedCardType || row.SchemaVersion != expectedSchemaVersion || row.SourceKind != cards.SourceEcho || row.ResourceType == nil || *row.ResourceType != expectedResourceType ||
		row.ResourceID == nil || *row.ResourceID != resourceID {
		return cards.NewError(cards.CodeCardNotFound, cards.MessageCardNotFound, 404)
	}
	return nil
}
