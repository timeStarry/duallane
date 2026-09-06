package solicitations

import (
	"errors"
	"fmt"
)

const (
	CodeAuthRequired            = "auth.required"
	CodePermissionDenied        = "echo.permission_denied"
	CodeInvalidSpace            = "echo.invalid_space"
	CodeSolicitationNotFound    = "echo.solicitation_not_found"
	CodeSolicitationIDInvalid   = "echo.solicitation_id_invalid"
	CodeTitleInvalid            = "echo.title_invalid"
	CodeDescriptionInvalid      = "echo.description_invalid"
	CodeQuestionInvalid         = "echo.question_invalid"
	CodeOptionsInvalid          = "echo.options_invalid"
	CodeOptionInvalid           = "echo.option_invalid"
	CodeChoiceModeInvalid       = "echo.choice_mode_invalid"
	CodeSelectionInvalid        = "echo.selection_invalid"
	CodeVotePolicyInvalid       = "echo.vote_policy_invalid"
	CodeResultVisibilityInvalid = "echo.result_visibility_invalid"
	CodeDeliveryPolicyInvalid   = "echo.delivery_policy_invalid"
	CodeStatusInvalid           = "echo.status_invalid"
	CodeLimitInvalid            = "echo.limit_invalid"
	CodeIdempotencyKeyInvalid   = "echo.idempotency_key_invalid"
	CodeIdempotencyConflict     = "echo.idempotency_conflict"
	CodeExpectedRevisionInvalid = "echo.expected_revision_invalid"
	CodeRevisionConflict        = "echo.revision_conflict"
	CodeInvalidTransition       = "echo.invalid_transition"
	CodeDeadlineInvalid         = "echo.deadline_invalid"
	CodeVoteClosed              = "echo.vote_closed"
	CodeVoteChangeForbidden     = "echo.vote_change_forbidden"
	CodeSequenceExhausted       = "echo.sequence_exhausted"
	CodeInvalidTime             = "echo.invalid_time"
	CodeDeliveryInvalid         = "echo.delivery_invalid"
	CodeDeliveryNotFound        = "echo.delivery_not_found"
	CodeCardTypeInvalid         = "echo.card_type_invalid"
	CodeCardDomainInvalid       = "card.domain_invalid"
	CodeCardActionInputInvalid  = "card.action_input_invalid"
	CodeInternal                = "internal.error"
)

const (
	MessageAuthRequired            = "请先登录共享空间"
	MessagePermissionDenied        = "你没有执行该操作的权限"
	MessageInvalidSpace            = "Workspace 空间无效"
	MessageSolicitationNotFound    = "征集不存在"
	MessageSolicitationIDInvalid   = "征集编号无效"
	MessageTitleInvalid            = "标题无效"
	MessageDescriptionInvalid      = "描述无效"
	MessageQuestionInvalid         = "问题无效"
	MessageOptionsInvalid          = "征集选项数量无效"
	MessageOptionInvalid           = "征集选项无效"
	MessageChoiceModeInvalid       = "选择模式无效"
	MessageSelectionInvalid        = "选择数量无效"
	MessageVotePolicyInvalid       = "投票修改策略无效"
	MessageResultVisibilityInvalid = "结果可见性无效"
	MessageDeliveryPolicyInvalid   = "投递策略无效"
	MessageStatusInvalid           = "征集状态无效"
	MessageLimitInvalid            = "列表数量无效"
	MessageIdempotencyKeyInvalid   = "幂等键无效"
	MessageIdempotencyConflict     = "幂等键已用于其他处理"
	MessageRevisionConflict        = "征集版本已变化，请刷新后重试"
	MessageInvalidTransition       = "征集状态不能这样变更"
	MessageDeadlineInvalid         = "截止时间必须晚于当前时间"
	MessageVoteClosed              = "征集已关闭"
	MessageVoteChangeForbidden     = "该征集不允许修改投票"
	MessageSequenceExhausted       = "本年度征集编号已用尽"
	MessageInvalidTime             = "时间无效"
	MessageDeliveryInvalid         = "投递状态无效"
	MessageDeliveryNotFound        = "投递不存在"
	MessageCardTypeInvalid         = "征集卡片类型无效"
	MessageCardDomainInvalid       = "征集卡片数据无效"
	MessageCardActionInputInvalid  = "投票参数无效"
	MessageInternal                = "服务暂时不可用"
)

// Error is the only error shape that should cross the Echo transport seam.
// Cause is retained for server diagnostics and is never serialized.
type Error struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	StatusCode int    `json:"-"`
	Cause      error  `json:"-"`
}

// TransactionRejection marks a domain-level rejection that has already
// written its content-free audit row through the caller's transaction. The
// caller must commit the transaction and return Err to its transport. It must
// not treat this marker like an infrastructure failure, because rolling back
// here would also erase the required rejection audit.
//
// A repository, SQL, or event failure is never wrapped in this type and must
// make the outer transaction roll back.
type TransactionRejection struct {
	Err      *Error
	TargetID string
	Reason   string
}

func (e *TransactionRejection) Error() string {
	if e == nil || e.Err == nil {
		return ""
	}
	return e.Err.Error()
}

func (e *TransactionRejection) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func (e *TransactionRejection) PublicError() *Error {
	if e == nil || e.Err == nil {
		return nil
	}
	return e.Err.Public()
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

// These aliases preserve the naming used by the Node service and let transport
// adapters use one stable Go error implementation.
type EchoSolicitationError = Error
type EchoSolicitationConflictError = Error
type EchoSolicitationNotFoundError = Error
type EchoSolicitationPermissionError = Error

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
	return internalError("workspace echo solicitations repository", err)
}

func authRequiredError() *Error {
	return NewError(CodeAuthRequired, MessageAuthRequired, 401)
}

func notFoundError() *Error {
	return NewError(CodeSolicitationNotFound, MessageSolicitationNotFound, 404)
}

func hiddenPermissionError() *Error {
	// The Node service deliberately hides draft and owner-only resources.
	return notFoundError()
}

func validationError(code, message string) *Error {
	return NewError(code, message, 400)
}

func conflictError(code, message string) *Error {
	return NewError(code, message, 409)
}
