package botgateway

import (
	"errors"
	"fmt"
)

const (
	CodeInvalidToken          = "bot.invalid_token"
	CodeScopeDenied           = "bot.scope_denied"
	CodeConversationInvalid   = "conversation.invalid"
	CodeConversationNotFound  = "conversation.not_found"
	CodeConversationForbidden = "bot.conversation_forbidden"
	CodeContextForbidden      = "bot.context_forbidden"
	CodeGatewayActorForbidden = "gateway.actor_forbidden"
	CodeMessageInvalid        = "message.invalid"
	CodeMessageInvalidReply   = "message.invalid_reply"
	CodeMessageUnavailable    = "message.unavailable"
	CodeIdempotencyInvalid    = "idempotency.invalid"
	CodeIdempotencyConflict   = "idempotency.conflict"
	CodeCardInvalidID         = "card.invalid_id"
	CodeCardInvalidType       = "card.invalid_type"
	CodeCardInvalidVersion    = "card.invalid_version"
	CodeCardInvalidFallback   = "card.invalid_fallback"
	CodeCardInvalidPayload    = "card.invalid_payload"
	CodeCardImmutableField    = "card.immutable_field"
	CodeCardUnavailable       = "card.unavailable"
	CodeCardNotFound          = "card.not_found"
	CodeCardRevisionConflict  = "card.revision_conflict"
	CodeAttachmentInvalid     = "attachment.invalid"
	CodeAttachmentNotFound    = "attachment.not_found"
	CodeAttachmentUnavailable = "attachment.unavailable"
	CodeInvalidAck            = "gateway.invalid_ack"
	CodeInvalidSequence       = "gateway.invalid_sequence"
	CodeInvalidRequest        = "gateway.invalid_request"
	CodeInternal              = "internal.error"
)

const (
	MessageInvalidToken          = "Bot Token 无效或已失效"
	MessageScopeDenied           = "Bot Token Scope 不足"
	MessageConversationInvalid   = "标识无效"
	MessageConversationNotFound  = "会话不存在或 Bot 未加入"
	MessageConversationForbidden = "Bot 当前策略不允许访问该会话"
	MessageContextForbidden      = "Bot 未获准读取该会话上下文"
	MessageActorForbidden        = "Bot 请求不得提交身份字段"
	MessageMessageInvalid        = "消息内容无效"
	MessageIdempotencyInvalid    = "幂等键无效"
	MessageIdempotencyConflict   = "幂等键对应的请求不一致"
	MessageCardUnavailable       = "卡片服务暂不可用"
	MessageAttachmentNotFound    = "附件不存在"
	MessageInvalidAck            = "事件确认无效"
	MessageInvalidSequence       = "事件序号无效"
	MessageInternal              = "服务暂时不可用"
)

// Error is the only error shape a transport adapter should expose. Cause is
// retained for server diagnostics and is never serialized to a client.
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
	return &Error{Code: CodeInternal, Message: MessageInternal, StatusCode: 500, Cause: fmt.Errorf("%s: %w", operation, cause)}
}

func normalizeError(err error) error {
	if err == nil {
		return nil
	}
	var value *Error
	if errors.As(err, &value) {
		return value
	}
	return internalError("workspace bot gateway operation", err)
}

func invalidTokenError() *Error {
	return NewError(CodeInvalidToken, MessageInvalidToken, 401)
}

func scopeDeniedError() *Error {
	return NewError(CodeScopeDenied, MessageScopeDenied, 403)
}

func invalidSequenceError() *Error {
	return NewError(CodeInvalidSequence, MessageInvalidSequence, 400)
}
