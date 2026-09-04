package messages

import (
	"errors"
	"fmt"
)

const (
	CodeAuthRequired             = "auth.required"
	CodeIdentityForbidden        = "auth.identity_forbidden"
	CodePermissionDenied         = "permission.denied"
	CodeConversationNotFound     = "conversation.not_found"
	CodeConversationRequired     = "conversation.required"
	CodeMessageInvalid           = "message.invalid"
	CodeMessageInvalidContent    = "message.invalid_content"
	CodeMessageUnsupported       = "message.unsupported_format"
	CodeMessageEmpty             = "message.empty"
	CodeMessageTooLong           = "message.too_long"
	CodeMessageInvalidBlock      = "message.invalid_block"
	CodeMessageInvalidText       = "message.invalid_text"
	CodeMessageInvalidMention    = "message.invalid_mention"
	CodeMessageInvalidLink       = "message.invalid_link"
	CodeMessageInvalidEmoji      = "message.invalid_emoji"
	CodeMessageInvalidAttach     = "message.invalid_attachment"
	CodeMessageInvalidReply      = "message.invalid_reply"
	CodeMessageIdempotency       = "message.idempotency_conflict"
	CodeMessageNotFound          = "message.not_found"
	CodeMessageRecallUnsupported = "message.recall_unsupported"
	CodeMessageRevisionConflict  = "message.revision_conflict"
	CodeReactionInvalidEmote     = "reaction.invalid_emote"
	CodeReactionUnsupported      = "reaction.unsupported_message"
	CodeInternal                 = "internal.error"
)

const (
	MessageAuthRequired         = "请先登录共享空间"
	MessageIdentityForbidden    = "该系统身份不能执行用户操作"
	MessagePermissionDenied     = "你没有执行该操作的权限"
	MessageConversationNotFound = "你无法访问此会话"
	MessageConversationRequired = "会话不能为空"
	MessageInvalid              = "消息参数无效"
	MessageInvalidContent       = "消息内容格式无效"
	MessageUnsupportedFormat    = "消息格式版本不支持"
	MessageEmpty                = "消息不能为空"
	MessageTooLong              = "消息正文过长，请作为文件发送"
	MessageInvalidBlock         = "消息块格式无效"
	MessageInvalidText          = "文本消息不能为空"
	MessageInvalidMention       = "只能提及当前会话成员"
	MessageInvalidLink          = "链接格式无效"
	MessageInvalidEmoji         = "表情格式无效"
	MessageInvalidAttachment    = "附件不可用"
	MessageInvalidReply         = "回复的消息不存在"
	MessageIdempotencyConflict  = "重复消息 ID 对应的内容不一致"
	MessageNotFound             = "消息不存在"
	MessageRecallUnsupported    = "该消息不能撤回"
	MessageRevisionConflict     = "消息状态已变化，请刷新后重试"
	MessageReactionInvalidEmote = "该表情不可用于消息回复"
	MessageReactionUnsupported  = "该消息不支持表情回复"
	MessageInternal             = "服务暂时不可用"
)

// Error is the only error shape that a Workspace transport should expose for
// this package. Cause is intentionally private so SQL and driver details do
// not cross the HTTP boundary.
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
	return &Error{
		Code:       CodeInternal,
		Message:    MessageInternal,
		StatusCode: 500,
		Cause:      fmt.Errorf("%s: %w", operation, cause),
	}
}

func domainError(err error) (*Error, bool) {
	var value *Error
	if errors.As(err, &value) {
		return value, true
	}
	return nil, false
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

func conversationNotFoundError() *Error {
	return NewError(CodeConversationNotFound, MessageConversationNotFound, 403)
}

func messageNotFoundError() *Error {
	return NewError(CodeMessageNotFound, MessageNotFound, 404)
}

func validationError(code, message string) *Error {
	return NewError(code, message, 400)
}

func revisionConflictError() *Error {
	return NewError(CodeMessageRevisionConflict, MessageRevisionConflict, 409)
}

func idempotencyConflictError() *Error {
	return NewError(CodeMessageIdempotency, MessageIdempotencyConflict, 409)
}
