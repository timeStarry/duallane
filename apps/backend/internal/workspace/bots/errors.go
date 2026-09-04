package bots

import (
	"errors"
	"fmt"
)

const (
	CodeAuthRequired                     = "auth.required"
	CodeIdentityForbidden                = "auth.identity_forbidden"
	CodePermissionDenied                 = "permission.denied"
	CodeSpaceInvalid                     = "space.invalid"
	CodeBotInvalidName                   = "bot.invalid_name"
	CodeBotReservedName                  = "bot.reserved_name"
	CodeBotAlreadyExists                 = "bot.already_exists"
	CodeBotNotFound                      = "bot.not_found"
	CodeBotInvalidSettings               = "bot.invalid_settings"
	CodeBotNotActive                     = "bot.not_active"
	CodeBotInvalidTransition             = "bot.invalid_transition"
	CodeBotInvalidScope                  = "bot.invalid_scope"
	CodeBotInvalidExpiry                 = "bot.invalid_expiry"
	CodeBotTokenIssueFailed              = "bot.token_issue_failed"
	CodeBotTokenNotFound                 = "bot.token_not_found"
	CodeBotInvalidToken                  = "bot.invalid_token"
	CodeBotInvalidGroupPolicy            = "bot.invalid_group_policy"
	CodeBotGroupPolicyForbidden          = "bot.group_policy_forbidden"
	CodeBotInvalidContextGrant           = "bot.invalid_context_grant"
	CodeBotContextGrantForbidden         = "bot.context_grant_forbidden"
	CodeBotSetupInvalid                  = "bot.setup_invalid"
	CodeBotSetupProtocolUnsupported      = "bot.setup_protocol_unsupported"
	CodeBotSetupNotFound                 = "bot.setup_not_found"
	CodeBotSetupNotRequestable           = "bot.setup_not_requestable"
	CodeBotSetupNotApprovable            = "bot.setup_not_approvable"
	CodeBotSetupNotDeniable              = "bot.setup_not_deniable"
	CodeBotSetupConflict                 = "bot.setup_conflict"
	CodeBotSetupNotApproved              = "bot.setup_not_approved"
	CodeBotSetupScopeNotRequested        = "bot.setup_scope_not_requested"
	CodeBotSetupConversationNotRequested = "bot.setup_conversation_not_requested"
	CodeInternal                         = "internal.error"
)

const (
	MessageAuthRequired                     = "请先登录共享空间"
	MessageIdentityForbidden                = "该系统身份不能执行用户操作"
	MessagePermissionDenied                 = "你没有执行该操作的权限"
	MessageSpaceInvalid                     = "Workspace 空间无效"
	MessageBotInvalidName                   = "Bot 名称无效"
	MessageBotReservedName                  = "该名称为系统保留名称"
	MessageBotAlreadyExists                 = "每个空间只能创建一个自定义 Bot"
	MessageBotNotFound                      = "Bot 不存在"
	MessageBotInvalidSettings               = "Bot 设置无效"
	MessageBotNotActive                     = "仅运行中的 Bot 可以执行该操作"
	MessageBotInvalidTransition             = "Bot 当前状态不允许执行该操作"
	MessageBotInvalidScope                  = "Bot Scope 无效"
	MessageBotInvalidExpiry                 = "Token 有效期无效"
	MessageBotTokenIssueFailed              = "暂时无法生成 Bot Token，请重试"
	MessageBotTokenNotFound                 = "Bot Token 不存在"
	MessageBotInvalidToken                  = "Bot Token 无效或已失效"
	MessageBotInvalidGroupPolicy            = "群聊策略无效"
	MessageBotGroupPolicyForbidden          = "Bot 当前设置不允许加入群聊"
	MessageBotInvalidContextGrant           = "私聊上下文授权无效"
	MessageBotContextGrantForbidden         = "只能配置与当前 Bot 的所有者私聊"
	MessageBotSetupInvalid                  = "配置会话无效"
	MessageBotSetupProtocolUnsupported      = "当前只支持 DualLane Gateway v1"
	MessageBotSetupNotFound                 = "配置会话不存在"
	MessageBotSetupNotRequestable           = "配置会话当前不能继续请求"
	MessageBotSetupNotApprovable            = "配置会话当前不能确认"
	MessageBotSetupNotDeniable              = "配置会话当前不能拒绝"
	MessageBotSetupConflict                 = "配置会话已被其他操作更新"
	MessageBotSetupNotApproved              = "配置会话尚未获得确认"
	MessageBotSetupScopeNotRequested        = "不能确认 Agent 未请求的权限"
	MessageBotSetupConversationNotRequested = "不能确认 Agent 未请求的会话"
	MessageInternal                         = "服务暂时不可用"
)

// Error is the only error shape intended for a future Workspace transport.
// Cause is retained for server diagnostics but is never serialized.
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
	var domainErr *Error
	if errors.As(err, &domainErr) {
		return domainErr
	}
	return internalError("workspace agent bot repository", err)
}

func authRequiredError() *Error { return NewError(CodeAuthRequired, MessageAuthRequired, 401) }

func identityForbiddenError() *Error {
	return NewError(CodeIdentityForbidden, MessageIdentityForbidden, 401)
}

func permissionDeniedError() *Error {
	return NewError(CodePermissionDenied, MessagePermissionDenied, 403)
}

func validationError(code, message string) *Error { return NewError(code, message, 400) }
func conflictError(code, message string) *Error   { return NewError(code, message, 409) }
func forbiddenError(code, message string) *Error  { return NewError(code, message, 403) }
func notFoundError(code, message string) *Error   { return NewError(code, message, 404) }
