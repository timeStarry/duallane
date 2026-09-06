package interactions

import (
	"context"
	"errors"
	"fmt"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
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

// TransactionRejection marks an expected domain rejection whose content-free
// audit has already been written to the caller-owned transaction. A
// composition layer may wrap the mutation in a savepoint; in that case it
// must roll back the business writes and re-write only this audit evidence
// after the savepoint is gone.
type TransactionRejection struct {
	Err      error
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

// InfrastructureMarker is implemented by trusted composition adapters when a
// callback cannot safely be represented as a business rejection. It is a
// marker rather than an Unwrap-only convention so errors.Join(4xx, infra)
// cannot be mistaken for a commit-safe rejection by errors.As.
type InfrastructureMarker interface {
	error
	InteractionInfrastructureFailure()
}

// infrastructureFailure is intentionally opaque to errors.As. Its cause is
// retained for the error string and internal diagnostics, but public error
// normalization must never discover a nested 4xx from a joined failure.
type infrastructureFailure struct {
	cause  error
	public *Error
}

func (e *infrastructureFailure) Error() string {
	if e == nil || e.cause == nil {
		return CodeInternal
	}
	return e.cause.Error()
}

func (e *infrastructureFailure) InteractionInfrastructureFailure() {}

func (e *infrastructureFailure) publicError() *Error {
	if e == nil || e.public == nil {
		return internalError("workspace interactions infrastructure failure", nil)
	}
	return e.public
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
	if shouldRollback(err) {
		return wrapInfrastructureFailure(err, "workspace interactions repository").(*infrastructureFailure).publicError()
	}
	var domain *Error
	if errors.As(err, &domain) {
		return domain
	}
	return internalError("workspace interactions repository", err)
}

type failureDisposition uint8

const (
	failureExpected failureDisposition = iota
	failureInfrastructure
)

// shouldRollback gives infrastructure precedence over every nested expected
// error. In particular, errors.Join(a4xx, anUnknownError) and
// errors.Join(a4xx, aSavepointFailure) are infrastructure failures.
func shouldRollback(err error) bool {
	return classifyFailure(err, 0) == failureInfrastructure
}

// IsInfrastructureFailure exposes the interaction-layer disposition to
// trusted adapters that must inspect domain-specific error graphs before
// converting them to interactions.Error. The adapter must preserve the
// original error when this returns true so a joined infrastructure leaf is
// not hidden by errors.As selecting a nested 4xx domain error.
func IsInfrastructureFailure(err error) bool {
	return shouldRollback(err)
}

func classifyFailure(err error, depth int) failureDisposition {
	if err == nil {
		return failureExpected
	}
	if depth > 64 || err == context.Canceled || err == context.DeadlineExceeded {
		return failureInfrastructure
	}
	if _, ok := err.(InfrastructureMarker); ok {
		return failureInfrastructure
	}
	switch typed := err.(type) {
	case *Error:
		if typed == nil || typed.StatusCode < 400 || typed.StatusCode >= 600 {
			return failureInfrastructure
		}
		if typed.Cause != nil && classifyFailure(typed.Cause, depth+1) == failureInfrastructure {
			return failureInfrastructure
		}
		if typed.StatusCode >= 500 {
			return failureInfrastructure
		}
		return failureExpected
	case *cards.CardValidationError:
		return failureExpected
	}
	if many, ok := err.(interface{ Unwrap() []error }); ok {
		children := many.Unwrap()
		if len(children) == 0 {
			return failureInfrastructure
		}
		for _, child := range children {
			if classifyFailure(child, depth+1) == failureInfrastructure {
				return failureInfrastructure
			}
		}
		return failureExpected
	}
	if one, ok := err.(interface{ Unwrap() error }); ok {
		child := one.Unwrap()
		if child == nil {
			return failureInfrastructure
		}
		return classifyFailure(child, depth+1)
	}
	return failureInfrastructure
}

func wrapInfrastructureFailure(err error, operation string) error {
	if err == nil {
		return nil
	}
	if existing, ok := err.(*infrastructureFailure); ok {
		return existing
	}
	public := internalError(operation, err)
	if direct, ok := err.(*Error); ok && direct != nil && direct.StatusCode >= 500 {
		public = direct
	}
	return &infrastructureFailure{cause: err, public: public}
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
