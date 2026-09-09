package members

import (
	"errors"
	"fmt"
)

const (
	CodeAuthRequired                     = "auth.required"
	CodeIdentityForbidden                = "auth.identity_forbidden"
	CodePermissionDenied                 = "permission.denied"
	CodeMemberNotFound                   = "member.not_found"
	CodeMemberNotVisible                 = "member.not_visible"
	CodeMemberRemarkUnsupported          = "member.remark_unsupported"
	CodeMemberRemarkInvalid              = "member.remark_invalid"
	CodeMemberRoleInvalid                = "member.role_invalid"
	CodeMemberSystemManaged              = "member.system_managed"
	CodeMemberLastOwner                  = "member.last_owner"
	CodeMemberRemoveInvalid              = "member.remove_invalid"
	CodeRoleInvalid                      = "role.invalid"
	CodeProfileNicknameInvalid           = "profile.nickname_invalid"
	CodeProfileSearchDiscoverableInvalid = "profile.search_discoverable_invalid"
	CodeProfileRecallReasonInvalid       = "profile.recall_reason_invalid"
	CodeInternal                         = "internal.error"
)

const (
	MessageAuthRequired              = "请先登录共享空间"
	MessageIdentityForbidden         = "该系统身份不能执行用户操作"
	MessagePermissionDenied          = "你没有执行该操作的权限"
	MessageMemberNotFound            = "空间成员不存在"
	MessageMemberNotVisible          = "成员当前不可见"
	MessageRemarkUnsupported         = "只能备注其他空间成员"
	MessageRemarkInvalid             = "备注应为 1 至 32 个有效字符"
	MessageMemberRoleInvalid         = "不能修改自己的权限"
	MessageMemberSystemManaged       = "系统成员的权限由服务维护"
	MessageMemberRemoveSystem        = "系统成员不能被移出空间"
	MessageMemberLastOwner           = "至少需要保留一位空间主人"
	MessageMemberRemoveInvalid       = "不能移出当前账号"
	MessageRoleInvalid               = "角色无效"
	MessageNicknameInvalid           = "昵称应为 1 至 32 个有效字符"
	MessageSearchDiscoverableInvalid = "搜索可见设置无效"
	MessageRecallReasonInvalid       = "撤回文案应为 1 至 16 个有效字符"
	MessageInternal                  = "服务暂时不可用"
)

// Error is the transport-safe domain error. Cause never serializes and may
// retain SQL/driver detail for server logs only.
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

func authRequiredError() *Error {
	return NewError(CodeAuthRequired, MessageAuthRequired, 401)
}

func identityForbiddenError() *Error {
	return NewError(CodeIdentityForbidden, MessageIdentityForbidden, 401)
}

func permissionDeniedError() *Error {
	return NewError(CodePermissionDenied, MessagePermissionDenied, 403)
}

func memberNotFoundError() *Error {
	return NewError(CodeMemberNotFound, MessageMemberNotFound, 400)
}

func validationError(code, message string) *Error {
	return NewError(code, message, 400)
}

func normalizeRepositoryError(err error) error {
	if err == nil {
		return nil
	}
	var domainErr *Error
	if errors.As(err, &domainErr) {
		return domainErr
	}
	return internalError("workspace member repository", err)
}
