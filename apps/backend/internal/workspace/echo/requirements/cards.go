package requirements

import (
	"errors"
	"math"
	"strings"

	workspacecards "github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
)

// normalizeRequirementCardType keeps the Echo card contract narrower than the
// generic workspace card registry. Empty means the default request card;
// non-empty values must be one of the three registered Echo projections.
func normalizeRequirementCardType(value string) (string, *Error) {
	if value == "" {
		return CardTypeRequirement, nil
	}
	if !contains(RequirementCardTypes[:], value) {
		return "", validationError(CodeCardTypeInvalid, MessageCardTypeInvalid)
	}
	return value, nil
}

// ValidateRequirementCardPayload is the domain validator used by the generic
// workspace card registry when Echo owns a card definition. It returns the
// generic card sanitizer's JSON-shaped value, never the caller's mutable map.
func ValidateRequirementCardPayload(cardType string, payload any) (any, error) {
	typeValue, err := normalizeRequirementCardType(cardType)
	if err != nil {
		return nil, err
	}
	limits := workspacecards.Limits{MaxPayloadBytes: 20 * 1024, MaxTextBytes: 14 * 1024}
	allowPublicURLs := true
	if typeValue == CardTypeRequirementStatus {
		limits = workspacecards.Limits{MaxPayloadBytes: 12 * 1024, MaxTextBytes: 8 * 1024}
	} else if typeValue == CardTypeRequirementList {
		limits = workspacecards.Limits{MaxPayloadBytes: 16 * 1024, MaxTextBytes: 8 * 1024}
		allowPublicURLs = false
	}
	normalized, normalizeErr := workspacecards.NormalizeCardPayload(payload, limits, allowPublicURLs)
	if normalizeErr != nil {
		return nil, normalizeWorkspaceCardError(normalizeErr)
	}
	object, ok := normalized.(map[string]any)
	if !ok {
		return nil, NewError("card.domain_invalid", "需求卡片内容无效", 422)
	}
	if typeValue == CardTypeRequirementList {
		if validationErr := validateRequirementCardListPayload(object); validationErr != nil {
			return nil, validationErr
		}
	} else if validationErr := validateRequirementCardPayload(typeValue, object); validationErr != nil {
		return nil, validationErr
	}
	return object, nil
}

func normalizeRequirementCardPayload(cardType string, payload map[string]any) (map[string]any, *Error) {
	typeValue, typeErr := normalizeRequirementCardType(cardType)
	if typeErr != nil {
		return nil, typeErr
	}
	limits := workspacecards.Limits{MaxPayloadBytes: 20 * 1024, MaxTextBytes: 14 * 1024}
	allowPublicURLs := true
	if typeValue == CardTypeRequirementStatus {
		limits = workspacecards.Limits{MaxPayloadBytes: 12 * 1024, MaxTextBytes: 8 * 1024}
	} else if typeValue == CardTypeRequirementList {
		limits = workspacecards.Limits{MaxPayloadBytes: 16 * 1024, MaxTextBytes: 8 * 1024}
		allowPublicURLs = false
	}
	value, normalizeErr := workspacecards.NormalizeCardPayload(payload, limits, allowPublicURLs)
	if normalizeErr != nil {
		return nil, asRequirementError(normalizeWorkspaceCardError(normalizeErr))
	}
	result, ok := value.(map[string]any)
	if !ok {
		return nil, NewError("card.domain_invalid", "需求卡片内容无效", 422)
	}
	return result, nil
}

func normalizeRequirementCardListPayload(payload map[string]any) (map[string]any, *Error) {
	value, err := ValidateRequirementCardPayload(CardTypeRequirementList, payload)
	if err != nil {
		return nil, asRequirementError(err)
	}
	result, ok := value.(map[string]any)
	if !ok {
		return nil, NewError("card.domain_invalid", "需求列表无效", 422)
	}
	return result, nil
}

func validateRequirementCardPayload(cardType string, payload map[string]any) *Error {
	publicID, ok := payload["publicId"].(string)
	if !ok || !publicIDPattern.MatchString(publicID) {
		return NewError("card.domain_invalid", "需求卡片编号无效", 422)
	}
	typeValue, typeOK := payload["type"].(string)
	state, stateOK := payload["state"].(string)
	if !typeOK || !contains(RequirementTypes[:], typeValue) || !stateOK || !contains(RequirementStates[:], state) {
		return NewError("card.domain_invalid", "需求卡片状态无效", 422)
	}
	if !isNonEmptyCardString(payload["title"]) {
		return NewError("card.domain_invalid", "需求卡片标题无效", 422)
	}
	if revision, ok := cardInteger(payload["revision"]); !ok || revision < 1 {
		return NewError("card.domain_invalid", "需求卡片版本无效", 422)
	}
	if phase, present := payload["phase"]; present {
		value, ok := phase.(string)
		if !ok || !contains(RequirementPhases[:], value) {
			return NewError("card.domain_invalid", "需求卡片阶段无效", 422)
		}
	}
	if status, present := payload["status"]; present {
		value, ok := status.(string)
		if !ok || !contains(RequirementStatuses[:], value) {
			return NewError("card.domain_invalid", "需求卡片状态无效", 422)
		}
	}
	if cardType == CardTypeRequirement && (!isNonEmptyCardString(payload["detail"]) || !isNonEmptyCardString(payload["scenario"]) || !isNonEmptyCardString(payload["expectedResult"])) {
		return NewError("card.domain_invalid", "需求卡片内容不完整", 422)
	}
	return nil
}

func validateRequirementCardListPayload(payload map[string]any) *Error {
	items, ok := payload["items"].([]any)
	if !ok || len(items) > 100 {
		return NewError("card.domain_invalid", "需求列表无效", 422)
	}
	for _, item := range items {
		object, ok := item.(map[string]any)
		if !ok {
			return NewError("card.domain_invalid", "需求列表无效", 422)
		}
		if err := validateRequirementCardPayload(CardTypeRequirementStatus, object); err != nil {
			return err
		}
	}
	return nil
}

// ValidateRequirementCardActionInput mirrors the action-input boundary used
// by the active card registry. It is deliberately independent of HTTP and
// does not perform authorization or transition writes.
func ValidateRequirementCardActionInput(actionID string, input map[string]any) (map[string]any, error) {
	if input == nil {
		return nil, NewError("card.action_input_invalid", "需求操作参数无效", 422)
	}
	key, ok := input["idempotencyKey"].(string)
	if !ok {
		return nil, NewError("card.action_input_invalid", "操作幂等键无效", 422)
	}
	key, keyErr := normalizeIdempotencyKey(key)
	if keyErr != nil {
		return nil, NewError("card.action_input_invalid", "操作幂等键无效", 422)
	}
	result := map[string]any{"idempotencyKey": key}
	if value, present := input["response"]; present && value != nil {
		response, ok := value.(string)
		if !ok || strings.TrimSpace(response) == "" {
			return nil, NewError("card.action_input_invalid", "处理说明无效", 422)
		}
		normalized, responseErr := boundedText(response, CodeResponseInvalid, MessageResponseInvalid, MaxResponseCodePoints, MaxResponseBytes)
		if responseErr != nil {
			return nil, NewError("card.action_input_invalid", "处理说明无效", 422)
		}
		result["response"] = normalized
	}
	if actionID == "duplicate" {
		value, ok := input["duplicateOfPublicId"].(string)
		if !ok {
			return nil, NewError("card.action_input_invalid", "重复需求必须指定目标编号", 422)
		}
		normalized, idErr := normalizePublicID(value)
		if idErr != nil {
			return nil, NewError("card.action_input_invalid", "重复需求必须指定目标编号", 422)
		}
		result["duplicateOfPublicId"] = normalized
	}
	return result, nil
}

func SafeRequirementActionResult(result Requirement) map[string]any {
	return map[string]any{
		"publicId": result.PublicID, "state": result.State, "phase": result.Phase,
		"status": result.Status, "archiveOutcome": result.ArchiveOutcome,
		"duplicateOfPublicId": result.DuplicateOfPublicID, "revision": result.Revision,
	}
}

func normalizeWorkspaceCardError(err error) error {
	var validation *workspacecards.CardValidationError
	if errors.As(err, &validation) && validation != nil {
		return NewError(validation.Code, validation.Message, 422)
	}
	return internalError("normalize echo requirement card", err)
}

func asRequirementError(err error) *Error {
	if err == nil {
		return nil
	}
	var domainErr *Error
	if errors.As(err, &domainErr) && domainErr != nil {
		return domainErr
	}
	return internalError("normalize echo requirement card", err)
}

func isNonEmptyCardString(value any) bool {
	text, ok := value.(string)
	return ok && strings.TrimSpace(text) != ""
}

func cardInteger(value any) (int64, bool) {
	switch number := value.(type) {
	case int:
		return int64(number), true
	case int8:
		return int64(number), true
	case int16:
		return int64(number), true
	case int32:
		return int64(number), true
	case int64:
		return number, true
	case uint:
		if uint64(number) > math.MaxInt64 {
			return 0, false
		}
		return int64(number), true
	case uint8:
		return int64(number), true
	case uint16:
		return int64(number), true
	case uint32:
		return int64(number), true
	case uint64:
		if number > math.MaxInt64 {
			return 0, false
		}
		return int64(number), true
	case float64:
		if math.IsNaN(number) || math.IsInf(number, 0) || math.Trunc(number) != number || number > math.MaxInt64 || number < math.MinInt64 {
			return 0, false
		}
		return int64(number), true
	default:
		return 0, false
	}
}
