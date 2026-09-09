package feishucards

import (
	"errors"
	"fmt"
)

// ValidationError is the stable, content-free error returned by the Feishu
// compatibility boundary. The message is kept for the existing Workspace
// transport contract; callers must not append the rejected card to it.
type ValidationError struct {
	Code    string
	Message string
}

func (e *ValidationError) Error() string {
	if e == nil {
		return ""
	}
	return e.Code
}

func validationError(code, message string) error {
	return &ValidationError{Code: code, Message: message}
}

func invalidInputError(cause error) error {
	if cause == nil {
		return validationError(CodeInvalid, "飞书卡片必须是 JSON 对象")
	}
	var validation *ValidationError
	if errors.As(cause, &validation) {
		return validation
	}
	return &ValidationError{Code: CodeInvalid, Message: fmt.Sprintf("飞书卡片必须是 JSON 对象: %v", cause)}
}

const (
	CodeInvalid              = "card.feishu_invalid"
	CodeElementsRequired     = "card.feishu_elements_required"
	CodeInvalidConfig        = "card.feishu_invalid_config"
	CodeUnsupportedVersion   = "card.feishu_unsupported_version"
	CodeInvalidHeader        = "card.feishu_invalid_header"
	CodeStyleForbidden       = "card.feishu_style_forbidden"
	CodeInvalidElement       = "card.feishu_invalid_element"
	CodeUnknownElement       = "card.feishu_unknown_element"
	CodeInvalidNote          = "card.feishu_invalid_note"
	CodeInvalidActions       = "card.feishu_invalid_actions"
	CodeInvalidButton        = "card.feishu_invalid_button"
	CodeInvalidAction        = "card.feishu_invalid_action"
	CodeDuplicateAction      = "card.feishu_duplicate_action"
	CodeInvalidColumns       = "card.feishu_invalid_columns"
	CodeInvalidColumn        = "card.feishu_invalid_column"
	CodeInvalidText          = "card.feishu_invalid_text"
	CodeUnknownAction        = "card.unknown_action"
	CodeActionInputForbidden = "card.feishu_action_input_forbidden"
	CodeInvalidPayload       = "card.invalid_payload"
	CodePayloadTooLarge      = "card.payload_too_large"
	CodePayloadTooComplex    = "card.payload_too_complex"
	CodePayloadTooDeep       = "card.payload_too_deep"
	CodeTextTooLarge         = "card.text_too_large"
	CodeUnsafeContent        = "card.unsafe_content"
	CodeInvalidURL           = "card.invalid_url"
	CodeURLForbidden         = "card.url_forbidden"
	CodePrivateURL           = "card.private_url"
	CodeInvalidType          = "card.invalid_type"
	CodeInvalidVersion       = "card.invalid_version"
	CodeInvalidDefinition    = "card.invalid_definition"
	CodeDuplicateDefinition  = "card.duplicate_definition"
	CodeActionUnavailable    = "card.action_unavailable"
)
