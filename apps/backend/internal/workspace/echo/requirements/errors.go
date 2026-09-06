package requirements

import (
	"errors"
	"fmt"
)

const (
	CodeAuthRequired              = "auth.required"
	CodePermissionDenied          = "echo.permission_denied"
	CodeInvalidSpace              = "echo.invalid_space"
	CodeRequirementNotFound       = "echo.requirement_not_found"
	CodeRequirementIDInvalid      = "echo.requirement_id_invalid"
	CodeTypeInvalid               = "echo.type_invalid"
	CodeTitleInvalid              = "echo.title_invalid"
	CodeDetailInvalid             = "echo.detail_invalid"
	CodeScenarioInvalid           = "echo.scenario_invalid"
	CodeExpectedResultInvalid     = "echo.expected_result_invalid"
	CodeRelatedLinkInvalid        = "echo.related_link_invalid"
	CodeStateInvalid              = "echo.state_invalid"
	CodePhaseInvalid              = "echo.phase_invalid"
	CodeStatusInvalid             = "echo.status_invalid"
	CodeArchiveOutcomeInvalid     = "echo.archive_outcome_invalid"
	CodeSubmitterInvalid          = "echo.submitter_invalid"
	CodeCreatedFromInvalid        = "echo.created_from_invalid"
	CodeCreatedToInvalid          = "echo.created_to_invalid"
	CodeCreatedRangeInvalid       = "echo.created_range_invalid"
	CodeLimitInvalid              = "echo.limit_invalid"
	CodeOffsetInvalid             = "echo.offset_invalid"
	CodeIdempotencyKeyInvalid     = "echo.idempotency_key_invalid"
	CodeIdempotencyConflict       = "echo.idempotency_conflict"
	CodeExpectedRevisionInvalid   = "echo.expected_revision_invalid"
	CodeRevisionConflict          = "echo.revision_conflict"
	CodeRejectionResponseRequired = "echo.rejection_response_required"
	CodeResponseInvalid           = "echo.response_invalid"
	CodeInvalidTransition         = "echo.invalid_transition"
	CodeDuplicateTargetInvalid    = "echo.duplicate_target_invalid"
	CodeSequenceExhausted         = "echo.sequence_exhausted"
	CodeInvalidTime               = "echo.invalid_time"
	CodeCardTypeInvalid           = "echo.card_type_invalid"
	CodeInternal                  = "internal.error"
)

const (
	MessageAuthRequired              = "请先登录共享空间"
	MessagePermissionDenied          = "你没有执行该操作的权限"
	MessageInvalidSpace              = "Workspace 空间无效"
	MessageRequirementNotFound       = "需求不存在"
	MessageRequirementIDInvalid      = "需求编号无效"
	MessageTypeInvalid               = "需求类型无效"
	MessageTitleInvalid              = "标题无效"
	MessageDetailInvalid             = "详细描述无效"
	MessageScenarioInvalid           = "使用场景无效"
	MessageExpectedResultInvalid     = "预期结果无效"
	MessageRelatedLinkInvalid        = "相关链接仅支持公开 HTTP(S) 地址"
	MessageStateInvalid              = "需求状态无效"
	MessagePhaseInvalid              = "需求阶段无效"
	MessageStatusInvalid             = "需求状态无效"
	MessageArchiveOutcomeInvalid     = "归档结果无效"
	MessageIdempotencyConflict       = "幂等键已用于其他处理"
	MessageSubmitIdempotencyConflict = "幂等键已用于其他提交"
	MessageRevisionConflict          = "需求版本已变化，请刷新后重试"
	MessageRejectionResponseRequired = "驳回时必须填写说明"
	MessageResponseInvalid           = "处理说明无效"
	MessageInvalidTransition         = "需求状态不能这样变更"
	MessageDuplicateTargetInvalid    = "重复需求引用无效"
	MessageSequenceExhausted         = "本年度需求编号已用尽"
	MessageCardTypeInvalid           = "需求卡片类型无效"
	MessageInternal                  = "服务暂时不可用"
)

// Error is the only error shape intended for an Echo transport. Cause never
// crosses the public boundary and is retained only for server diagnostics.
type Error struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	StatusCode int    `json:"-"`
	Cause      error  `json:"-"`
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	return e.Code
}

func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

func (e *Error) Public() *Error {
	if e == nil {
		return nil
	}
	return &Error{Code: e.Code, Message: e.Message, StatusCode: e.StatusCode}
}

// The aliases preserve the names used by the Node characterization tests and
// by early Go callers while keeping one error implementation.
type EchoRequirementError = Error
type EchoRequirementConflictError = Error
type EchoRequirementNotFoundError = Error
type EchoRequirementPermissionError = Error

func NewError(code, message string, statusCode int) *Error {
	return &Error{Code: code, Message: message, StatusCode: statusCode}
}

func internalError(operation string, cause error) *Error {
	if cause == nil {
		cause = errors.New(operation)
	}
	return &Error{Code: CodeInternal, Message: MessageInternal, StatusCode: 500, Cause: fmt.Errorf("%s: %w", operation, cause)}
}

func normalizeError(err error) error {
	if err == nil {
		return nil
	}
	var domainErr *Error
	if errors.As(err, &domainErr) && domainErr != nil {
		return domainErr
	}
	return internalError("workspace echo requirements repository", err)
}

func authRequiredError() *Error { return NewError(CodeAuthRequired, MessageAuthRequired, 401) }
func notFoundError() *Error {
	return NewError(CodeRequirementNotFound, MessageRequirementNotFound, 404)
}
func validationError(code, message string) *Error { return NewError(code, message, 400) }
func conflictError(code, message string) *Error   { return NewError(code, message, 409) }
