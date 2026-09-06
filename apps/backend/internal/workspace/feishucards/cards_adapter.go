package feishucards

import (
	"context"
	"encoding/json"
	"errors"

	workspacecards "github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
)

// AsCardsDefinition is an additive composition adapter for the existing
// Workspace card registry. It does not own a repository or a transaction.
// Action execution succeeds only when the caller's cards.Tx also implements
// this package's Tx bridge, so card service rollback remains authoritative.
func AsCardsDefinition() workspacecards.CardDefinition {
	definition := FeishuDefinition()
	actions := make(map[string]workspacecards.CardAction, len(definition.Actions))
	for actionID, action := range definition.Actions {
		id := actionID
		actions[id] = workspacecards.CardAction{
			ID:     id,
			Limits: toCardsLimits(action.Limits),
			ValidateInput: func(value any) (any, error) {
				validated, err := ValidateEmptyActionInput(value)
				return validated, adaptValidationError(err)
			},
			Execute: func(ctx context.Context, input workspacecards.CardActionContext) (workspacecards.CardActionResult, error) {
				bridge, ok := input.Tx.(Tx)
				if !ok || bridge == nil {
					return workspacecards.CardActionResult{}, adaptValidationError(validationError(CodeActionUnavailable, "卡片操作暂不可用"))
				}
				conversationID := ""
				if input.Card.ConversationID != nil {
					conversationID = *input.Card.ConversationID
				}
				actorID := ""
				if input.Actor != nil {
					actorID = input.Actor.ID
				}
				payload := input.Payload
				if len(input.PayloadJSON) > 0 {
					payload = input.PayloadJSON
				}
				result, err := ExecuteAction(ctx, id, ActionContext{
					Tx:             bridge,
					ActorID:        actorID,
					Card:           CardRef{ID: input.Card.ID, SpaceID: input.Card.SpaceID, ConversationID: conversationID},
					Payload:        payload,
					Input:          input.Input,
					ClientActionID: input.ClientActionID,
				})
				if err != nil {
					return workspacecards.CardActionResult{}, adaptValidationError(err)
				}
				return workspacecards.CardActionResult{Result: result.Result, ActionEventWritten: true}, nil
			},
		}
	}
	return workspacecards.CardDefinition{
		CardType:        definition.CardType,
		SchemaVersion:   definition.SchemaVersion,
		AllowPublicURLs: definition.AllowPublicURLs,
		Limits:          toCardsLimits(definition.Limits),
		ValidatePayloadJSON: func(value json.RawMessage) (json.RawMessage, error) {
			validated, err := ValidatePayloadJSON(value)
			return validated, adaptValidationError(err)
		},
		Actions: actions,
		ValidatePayload: func(value any) (any, error) {
			validated, err := ValidatePayload(value)
			return validated, adaptValidationError(err)
		},
	}
}

func toCardsLimits(value Limits) workspacecards.Limits {
	return workspacecards.Limits{
		MaxPayloadBytes: value.MaxPayloadBytes,
		MaxDepth:        value.MaxDepth,
		MaxNodes:        value.MaxNodes,
		MaxTextBytes:    value.MaxTextBytes,
	}
}

func adaptValidationError(err error) error {
	if err == nil {
		return nil
	}
	var validation *ValidationError
	if errors.As(err, &validation) {
		return &workspacecards.CardValidationError{Code: validation.Code, Message: validation.Message}
	}
	return err
}
