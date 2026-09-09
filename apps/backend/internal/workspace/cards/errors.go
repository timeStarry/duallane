package cards

import (
	"errors"
	"fmt"
)

const (
	CodeAuthRequired             = "auth.required"
	CodeIdentityForbidden        = "auth.identity_forbidden"
	CodePermissionDenied         = "permission.denied"
	CodeCardInvalid              = "card.invalid"
	CodeCardInvalidID            = "card.invalid_id"
	CodeCardInvalidType          = "card.invalid_type"
	CodeCardInvalidVersion       = "card.invalid_version"
	CodeCardInvalidBlock         = "card.invalid_block"
	CodeCardInvalidPayload       = "card.invalid_payload"
	CodeCardPayloadLarge         = "card.payload_too_large"
	CodeCardPayloadComplex       = "card.payload_too_complex"
	CodeCardPayloadDeep          = "card.payload_too_deep"
	CodeCardTextLarge            = "card.text_too_large"
	CodeCardUnsafeContent        = "card.unsafe_content"
	CodeCardInvalidURL           = "card.invalid_url"
	CodeCardURLForbidden         = "card.url_forbidden"
	CodeCardPrivateURL           = "card.private_url"
	CodeCardInvalidFallback      = "card.invalid_fallback"
	CodeCardInvalidSource        = "card.invalid_source"
	CodeCardInvalidSpace         = "card.invalid_space"
	CodeCardInvalidConversation  = "card.invalid_conversation"
	CodeCardSourceForbidden      = "card.source_forbidden"
	CodeCardUnknownVersion       = "card.unknown_version"
	CodeCardUnknownAction        = "card.unknown_action"
	CodeCardInvalidAction        = "card.invalid_action"
	CodeCardInvalidClientAction  = "card.invalid_client_action_id"
	CodeCardInvalidRevision      = "card.invalid_revision"
	CodeCardStaleRevision        = "card.stale_revision"
	CodeCardRevisionConflict     = "card.revision_conflict"
	CodeCardNotFound             = "card.not_found"
	CodeCardReferenceMismatch    = "card.reference_mismatch"
	CodeCardNotActionable        = "card.not_actionable"
	CodeCardActionInProgress     = "card.action_in_progress"
	CodeCardIdempotencyConflict  = "card.idempotency_conflict"
	CodeCardSourceConflict       = "card.source_conflict"
	CodeCardInvalidVisibility    = "card.invalid_visibility"
	CodeCardConversationRequired = "card.conversation_required"
	CodeCardResourceRequired     = "card.resource_required"
	CodeCardInvalidResource      = "card.invalid_resource"
	CodeCardInvalidExpiry        = "card.invalid_expiry"
	CodeCardInvalidStatus        = "card.invalid_status"
	CodeCardImmutableField       = "card.immutable_field"
	CodeCardInvalidOwner         = "card.invalid_owner"
	CodeInternal                 = "internal.error"
)

const (
	MessageAuthRequired       = "请先登录共享空间"
	MessageIdentityForbidden  = "该系统身份不能执行用户操作"
	MessagePermissionDenied   = "你没有执行该操作的权限"
	MessageCardNotFound       = "卡片不存在或不可访问"
	MessageCardUnknownVersion = "卡片版本暂不支持"
	MessageCardActionFailed   = "卡片操作失败"
)

// Error is the only error shape that a cards transport should expose. Cause
// is intentionally private so SQL/provider details never cross the boundary.
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

func NewError(code, message string, statusCode int) *Error {
	return &Error{Code: code, Message: message, StatusCode: statusCode}
}

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
	var domainErr *Error
	if errors.As(err, &domainErr) {
		return domainErr
	}
	return internalError("workspace cards repository", err)
}

func authRequiredError() *Error {
	return NewError(CodeAuthRequired, MessageAuthRequired, 401)
}

func identityForbiddenError() *Error {
	return NewError(CodeIdentityForbidden, MessageIdentityForbidden, 401)
}

func permissionDeniedError() *Error {
	return NewError(CodePermissionDenied, MessagePermissionDenied, 403)
}

func notFoundError() *Error {
	return NewError(CodeCardNotFound, MessageCardNotFound, 404)
}

func unknownVersionError() *Error {
	return NewError(CodeCardUnknownVersion, MessageCardUnknownVersion, 422)
}

func conflictError(code, message string) *Error {
	return NewError(code, message, 409)
}
