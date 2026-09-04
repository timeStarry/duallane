package interactions

import (
	"errors"
	"fmt"
)

const (
	CodeAuthRequired                = "auth.required"
	CodePermissionDenied            = "permission.denied"
	CodeConversationNotFound        = "conversation.not_found"
	CodeBotNotAvailable             = "bot.not_available"
	CodeSpaceInvalid                = "space.invalid"
	CodeConversationInvalid         = "conversation.invalid"
	CodeCommandInvalid              = "command.invalid"
	CodeCommandNotTriggered         = "command.not_triggered"
	CodeCommandUnknown              = "command.unknown"
	CodeCommandInvalidInvocation    = "command.invalid_client_invocation_id"
	CodeCommandIdempotencyConflict  = "command.idempotency_conflict"
	CodeCommandInProgress           = "command.in_progress"
	CodeCommandFailed               = "command.failed"
	CodeWorkflowUnknown             = "workflow.unknown"
	CodeWorkflowInvalidID           = "workflow.invalid_id"
	CodeWorkflowInvalidType         = "workflow.invalid_type"
	CodeWorkflowInvalidVersion      = "workflow.invalid_version"
	CodeWorkflowInvalidInvocation   = "workflow.invalid_client_invocation_id"
	CodeWorkflowIdempotencyConflict = "workflow.idempotency_conflict"
	CodeWorkflowActiveConflict      = "workflow.active_conflict"
	CodeWorkflowInvalidTTL          = "workflow.invalid_ttl"
	CodeWorkflowInvalidRevision     = "workflow.invalid_revision"
	CodeWorkflowStaleRevision       = "workflow.stale_revision"
	CodeWorkflowRaceConflict        = "workflow.race_conflict"
	CodeWorkflowNotFound            = "workflow.not_found"
	CodeWorkflowNotActive           = "workflow.not_active"
	CodeWorkflowExpired             = "workflow.expired"
	CodeWorkflowActiveNotFound      = "workflow.active_not_found"
	CodeWorkflowActiveAmbiguous     = "workflow.active_ambiguous"
	CodeWorkflowFailed              = "workflow.failed"
	CodeInteractionRateLimited      = "interaction.rate_limited"
	CodeInternal                    = "internal.error"
)

const (
	MessageAuthRequired           = "请先登录共享空间"
	MessagePermissionDenied       = "无权执行该操作"
	MessageConversationNotFound   = "会话不存在"
	MessageBotNotAvailable        = "Bot 不在当前会话中"
	MessageCommandNotTriggered    = "当前消息不会触发 Bot 命令"
	MessageCommandUnknown         = "命令不存在"
	MessageWorkflowUnknown        = "引导流程不存在"
	MessageWorkflowUnknownVersion = "引导流程版本暂不支持"
	MessageWorkflowNotActive      = "引导流程已结束"
	MessageWorkflowExpired        = "引导流程已过期"
	MessageWorkflowNotFound       = "引导流程不存在或不可访问"
	MessageRateLimited            = "操作过于频繁，请稍后再试"
)

type Error struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	StatusCode int    `json:"-"`
	Details    any    `json:"details,omitempty"`
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
	return &Error{Code: e.Code, Message: e.Message, StatusCode: e.StatusCode, Details: e.Details}
}
func NewError(code, message string, status int) *Error {
	return &Error{Code: code, Message: message, StatusCode: status}
}
func conflict(code, message string) *Error { return NewError(code, message, 409) }
func internalError(operation string, cause error) *Error {
	if cause == nil {
		cause = errors.New(operation)
	}
	return &Error{Code: CodeInternal, Message: "服务暂时不可用", StatusCode: 500, Cause: fmt.Errorf("%s: %w", operation, cause)}
}
func normalizeError(err error) error {
	if err == nil {
		return nil
	}
	var domain *Error
	if errors.As(err, &domain) {
		return domain
	}
	return internalError("workspace interactions repository", err)
}
func authRequiredError() *Error { return NewError(CodeAuthRequired, MessageAuthRequired, 401) }
func permissionDeniedError() *Error {
	return NewError(CodePermissionDenied, MessagePermissionDenied, 403)
}
func conversationNotFoundError() *Error {
	return NewError(CodeConversationNotFound, MessageConversationNotFound, 404)
}
func botNotAvailableError() *Error { return NewError(CodeBotNotAvailable, MessageBotNotAvailable, 404) }
func workflowNotFoundError() *Error {
	return NewError(CodeWorkflowNotFound, MessageWorkflowNotFound, 404)
}
