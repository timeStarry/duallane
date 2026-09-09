package topics

import (
	"errors"
	"fmt"
)

type transactionRejection struct{ err *Error }

func (e *transactionRejection) Error() string { return e.err.Error() }
func (e *transactionRejection) Unwrap() error { return e.err }

// IsTransactionRejection distinguishes an audited, pre-mutation rejection from
// an infrastructure or post-mutation error that must roll back the entire unit.
func IsTransactionRejection(err error) bool {
	var rejected *transactionRejection
	return errors.As(err, &rejected)
}

const (
	CodeAuthRequired             = "auth.required"
	CodeIdentityForbidden        = "auth.identity_forbidden"
	CodePermissionDenied         = "permission.denied"
	CodeTopicNotFound            = "topic.not_found"
	CodeTopicGroupOnly           = "topic.group_only"
	CodeTopicInvalidID           = "topic.invalid_id"
	CodeTopicInvalidTitle        = "topic.invalid_title"
	CodeTopicInvalidDescription  = "topic.invalid_description"
	CodeTopicInvalidStatus       = "topic.invalid_status"
	CodeTopicInvalidConversation = "topic.invalid_conversation"
	CodeTopicInvalidLimit        = "topic.invalid_limit"
	CodeTopicInvalidIdempotency  = "topic.invalid_idempotency_key"
	CodeTopicIdempotencyConflict = "topic.idempotency_conflict"
	CodeTopicInvalidSyncPolicy   = "topic.invalid_sync_policy"
	CodeTopicNotOpen             = "topic.not_open"
	CodeTopicCreatorRequired     = "topic.creator_required"
	CodeTopicRevisionConflict    = "topic.revision_conflict"
	CodeTopicInvalidTransition   = "topic.invalid_transition"
	CodeTopicNotMember           = "topic.not_member"
	CodeTopicNotificationInvalid = "topic.notification_invalid"
	CodeTopicInvalidContent      = "topic.invalid_content"
	CodeTopicEmptyMessage        = "topic.empty_message"
	CodeTopicInvalidBlock        = "topic.invalid_block"
	CodeTopicInvalidText         = "topic.invalid_text"
	CodeTopicInvalidMention      = "topic.invalid_mention"
	CodeTopicInvalidLink         = "topic.invalid_link"
	CodeTopicInvalidEmoji        = "topic.invalid_emoji"
	CodeTopicMessageTooLong      = "topic.message_too_long"
	CodeTopicInvalidReply        = "topic.invalid_reply"
	CodeTopicMessageRequired     = "topic.message_required"
	CodeTopicMessageNotFound     = "topic.message_not_found"
	CodeTopicInvalidCursor       = "topic.invalid_cursor"
	CodeTopicInvalidClientID     = "topic.invalid_client_message_id"
	CodeTopicSyncDisabled        = "topic.sync_disabled"
	CodeTopicSyncConflict        = "topic.sync_conflict"
	CodeTopicRateLimited         = "topic.rate_limited"
	CodeInternal                 = "internal.error"
)

const (
	MessageAuthRequired             = "请先登录共享空间"
	MessageIdentityForbidden        = "该系统身份不能执行用户操作"
	MessagePermissionDenied         = "你没有执行该操作的权限"
	MessageTopicNotFound            = "话题不存在"
	MessageTopicGroupOnly           = "话题只能绑定群聊"
	MessageTopicInvalidID           = "话题 ID 无效"
	MessageTopicInvalidTitle        = "话题标题无效"
	MessageTopicInvalidDescription  = "话题正文无效"
	MessageTopicInvalidStatus       = "话题状态筛选无效"
	MessageTopicInvalidConversation = "群聊 ID 无效"
	MessageTopicInvalidLimit        = "话题列表长度无效"
	MessageTopicInvalidIdempotency  = "幂等键无效"
	MessageTopicIdempotencyConflict = "重复请求对应的话题内容不一致"
	MessageTopicInvalidSyncPolicy   = "同步策略无效"
	MessageTopicNotOpen             = "话题已关闭"
	MessageTopicCreatorRequired     = "创建者需先关闭话题才能退出"
	MessageTopicRevisionConflict    = "话题版本已变化，请刷新后重试"
	MessageTopicInvalidTransition   = "话题状态不能转换"
	MessageTopicNotMember           = "你不是话题成员"
	MessageTopicNotificationInvalid = "话题提醒方式无效"
	MessageTopicInvalidContent      = "消息内容格式无效"
	MessageTopicEmptyMessage        = "消息不能为空"
	MessageTopicInvalidBlock        = "消息块格式无效"
	MessageTopicInvalidText         = "文本消息不能为空"
	MessageTopicInvalidMention      = "只能提及当前话题成员"
	MessageTopicInvalidLink         = "链接无效"
	MessageTopicInvalidEmoji        = "表情格式无效"
	MessageTopicMessageTooLong      = "话题消息过长"
	MessageTopicInvalidReply        = "回复的话题消息不存在"
	MessageTopicMessageRequired     = "话题消息不能为空"
	MessageTopicMessageNotFound     = "话题消息不存在"
	MessageTopicInvalidCursor       = "消息游标无效"
	MessageTopicInvalidClientID     = "消息幂等 ID 无效"
	MessageTopicSyncDisabled        = "该话题未开启同步到群聊"
	MessageTopicSyncConflict        = "话题消息同步冲突，请重试"
	MessageTopicRateLimited         = "操作过于频繁，请稍后再试"
	MessageInternal                 = "服务暂时不可用"
)

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

func authRequiredError() *Error { return NewError(CodeAuthRequired, MessageAuthRequired, 401) }
func identityForbiddenError() *Error {
	return NewError(CodeIdentityForbidden, MessageIdentityForbidden, 401)
}
func permissionDeniedError() *Error {
	return NewError(CodePermissionDenied, MessagePermissionDenied, 403)
}
func topicNotFoundError() *Error                       { return NewError(CodeTopicNotFound, MessageTopicNotFound, 404) }
func topicValidationError(code, message string) *Error { return NewError(code, message, 400) }
func topicConflictError(code, message string) *Error   { return NewError(code, message, 409) }

func normalizeRepositoryError(err error) error {
	if err == nil {
		return nil
	}
	var domainErr *Error
	if errors.As(err, &domainErr) {
		return domainErr
	}
	return internalError("workspace topic repository", err)
}
