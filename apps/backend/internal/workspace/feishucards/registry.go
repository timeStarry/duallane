package feishucards

import (
	"context"
)

func FeishuDefinition() Definition {
	actions := make(map[string]ActionDefinition, len(ActionIDs))
	for _, actionID := range ActionIDs {
		id := actionID
		actions[id] = ActionDefinition{
			ID:            id,
			Limits:        ActionLimits,
			ValidateInput: ValidateEmptyActionInput,
			Execute: func(ctx context.Context, input ActionContext) (ActionResult, error) {
				return ExecuteAction(ctx, id, input)
			},
		}
	}
	return Definition{
		CardType:        CardType,
		SchemaVersion:   SchemaVersion,
		AllowPublicURLs: true,
		Limits:          DefaultLimits,
		Actions:         actions,
		ValidatePayload: ValidatePayload,
	}
}

func ValidateEmptyActionInput(value any) (any, error) {
	raw, err := rawMessage(value)
	if err != nil {
		return nil, validationError(CodeInvalidAction, "飞书卡片动作参数无效")
	}
	parsed, err := parseOrderedJSON(raw)
	if err != nil || parsed.kind != jsonObject {
		return nil, validationError(CodeInvalidAction, "飞书卡片动作参数无效")
	}
	if len(parsed.object) > 0 {
		return nil, validationError(CodeActionInputForbidden, "飞书卡片动作不接受客户端参数")
	}
	return map[string]any{}, nil
}

func ExecuteAction(ctx context.Context, actionID string, input ActionContext) (ActionResult, error) {
	allowed, err := normalizeAllowedActions(nil)
	if err != nil {
		return ActionResult{}, err
	}
	normalizedActionID, err := normalizeActionID(makeString(actionID), allowed)
	if err != nil {
		return ActionResult{}, err
	}
	payloadRaw, err := rawMessage(input.Payload)
	if err != nil {
		return ActionResult{}, validationError(CodeUnknownAction, "飞书卡片动作未注册")
	}
	payload, err := parseOrderedJSON(payloadRaw)
	if err != nil {
		return ActionResult{}, validationError(CodeUnknownAction, "飞书卡片动作未注册")
	}
	button, found := findActionButton(payload, normalizedActionID)
	if !found {
		return ActionResult{}, validationError(CodeUnknownAction, "飞书卡片动作未注册")
	}
	if input.Tx == nil {
		return ActionResult{}, validationError(CodeActionUnavailable, "卡片操作暂不可用")
	}
	bot, found, err := input.Tx.FindActiveBotForCard(ctx, input.Card.ID, input.Card.SpaceID)
	if err != nil {
		return ActionResult{}, err
	}
	if !found {
		return ActionResult{}, validationError(CodeUnknownAction, "飞书卡片动作未注册")
	}
	eventPayload := makeObject(
		jsonField{key: "botId", value: makeString(bot.ID)},
		jsonField{key: "botUserId", value: makeString(bot.UserID)},
		jsonField{key: "cardId", value: makeString(input.Card.ID)},
		jsonField{key: "actionId", value: makeString(normalizedActionID)},
		jsonField{key: "clientActionId", value: makeString(input.ClientActionID)},
		jsonField{key: "data", value: button.data},
	)
	eventJSON, err := eventPayload.marshalJSON()
	if err != nil {
		return ActionResult{}, err
	}
	if err := input.Tx.WriteCardActionEvent(ctx, CardActionEvent{
		SpaceID:        input.Card.SpaceID,
		Type:           "card.action",
		ActorID:        input.ActorID,
		ConversationID: input.Card.ConversationID,
		TargetType:     "workspace.card",
		TargetID:       input.Card.ID,
		PayloadJSON:    eventJSON,
	}); err != nil {
		return ActionResult{}, err
	}
	return ActionResult{Result: map[string]any{"accepted": true, "actionId": normalizedActionID}}, nil
}

type actionButton struct {
	data orderedValue
}

func findActionButton(payload orderedValue, actionID string) (actionButton, bool) {
	elements := fieldOrNull(payload, "elements")
	if elements.kind != jsonArray {
		return actionButton{}, false
	}
	for _, element := range elements.array {
		if typeValue, ok := stringValue(fieldOrNull(element, "type")); ok && typeValue == "actions" {
			buttons := fieldOrNull(element, "buttons")
			if buttons.kind == jsonArray {
				for _, button := range buttons.array {
					candidate, ok := stringValue(fieldOrNull(button, "actionId"))
					if ok && candidate == actionID {
						return actionButton{data: fieldOrNull(button, "data")}, true
					}
				}
			}
		}
		if typeValue, ok := stringValue(fieldOrNull(element, "type")); ok && typeValue == "columns" {
			columns := fieldOrNull(element, "columns")
			if columns.kind == jsonArray {
				for _, column := range columns.array {
					if button, ok := findActionButton(makeObject(jsonField{key: "elements", value: fieldOrNull(column, "elements")}), actionID); ok {
						return button, true
					}
				}
			}
		}
	}
	return actionButton{}, false
}
