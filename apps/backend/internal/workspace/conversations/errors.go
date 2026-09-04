package conversations

import (
	"errors"
	"fmt"
)

const (
	CodeAuthRequired                    = "auth.required"
	CodeIdentityForbidden               = "auth.identity_forbidden"
	CodePermissionDenied                = "permission.denied"
	CodeConversationNotFound            = "conversation.not_found"
	CodeConversationRequired            = "conversation.required"
	CodeConversationInvalidType         = "conversation.invalid_type"
	CodeConversationInvalidTarget       = "conversation.invalid_target"
	CodeConversationInvalidTitle        = "conversation.invalid_title"
	CodeConversationInvalidMembers      = "conversation.invalid_members"
	CodeConversationInvalidAvatar       = "conversation.invalid_avatar"
	CodeConversationInvalidUpdate       = "conversation.invalid_update"
	CodeConversationMemberInvalid       = "conversation.member_invalid"
	CodeConversationMemberNotFound      = "conversation.member_not_found"
	CodeConversationNotificationInvalid = "conversation.notification_invalid"
	CodeMemberNotFound                  = "member.not_found"
	CodeMemberNotVisible                = "member.not_visible"
	CodeMemberNotChatParticipant        = "member.not_chat_participant"
	CodePinGroupOnly                    = "pin.group_only"
	CodePinNotAuthor                    = "pin.not_author"
	CodePinLimitReached                 = "pin.limit_reached"
	CodeMessageNotFound                 = "message.not_found"
	CodeInternal                        = "internal.error"
)

const (
	MessageAuthRequired                    = "请先登录共享空间"
	MessageIdentityForbidden               = "该系统身份不能执行用户操作"
	MessagePermissionDenied                = "你没有执行该操作的权限"
	MessagePinPermissionDenied             = "你没有取消此常驻消息的权限"
	MessageConversationNotFound            = "你无法访问此会话"
	MessageConversationRequired            = "会话不能为空"
	MessageConversationInvalidType         = "会话类型无效"
	MessageConversationInvalidTarget       = "请选择一个空间成员"
	MessageConversationTargetMissing       = "成员不存在或当前不可见"
	MessageConversationInvalidTitle        = "请输入群聊名称"
	MessageConversationTitleTooLong        = "群聊名称过长"
	MessageConversationInvalidMembers      = "请选择至少一位群聊成员"
	MessageConversationInvalidAvatar       = "群头像必须是单个 emoji"
	MessageConversationInvalidUpdate       = "没有可更新的群聊资料"
	MessageConversationMemberInvalid       = "不能在此处移出自己"
	MessageConversationLastMember          = "最后一位成员不能离开群聊"
	MessageConversationMemberNotFound      = "该成员不在群聊中"
	MessageConversationNotificationInvalid = "请选择有效的提醒方式"
	MessageMemberNotFound                  = "空间成员不存在"
	MessageMemberNotVisible                = "成员当前不可见"
	MessageMemberNotChatParticipant        = "请选择可加入群聊的空间成员"
	MessagePinGroupOnly                    = "只有群聊支持常驻消息"
	MessagePinNotAuthor                    = "只能常驻自己发送的消息"
	MessagePinLimitReached                 = "每人在每个群聊最多常驻 3 条消息"
	MessageMessageNotFound                 = "消息不存在"
	MessageInternal                        = "服务暂时不可用"
)

// Error is the domain error shape that the transport layer may safely expose.
// Cause is kept private from JSON so SQL and driver details cannot cross the
// HTTP boundary.
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

func isCode(err error, code string) bool {
	var domainErr *Error
	return errors.As(err, &domainErr) && domainErr.Code == code
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

func pinPermissionDeniedError() *Error {
	return NewError(CodePermissionDenied, MessagePinPermissionDenied, 403)
}

func conversationNotFoundError() *Error {
	return NewError(CodeConversationNotFound, MessageConversationNotFound, 403)
}

func messageNotFoundError() *Error {
	return NewError(CodeMessageNotFound, MessageMessageNotFound, 404)
}
