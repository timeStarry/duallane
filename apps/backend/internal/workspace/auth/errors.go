package auth

import (
	"errors"
	"fmt"
)

const (
	CodeRequired            = "auth.required"
	CodeIdentityForbidden   = "auth.identity_forbidden"
	CodeIdentityConflict    = "auth.identity_conflict"
	CodeNotInvited          = "auth.not_invited"
	CodeInvalidProfile      = "auth.invalid_profile"
	CodeInvalidState        = "auth.invalid_state"
	CodeGitHubFailed        = "auth.github_failed"
	CodeGitHubNotConfigured = "auth.github_not_configured"
	CodeGitHubRequired      = "auth.github_required"

	CodeInviteInvalid   = "invite.invalid"
	CodeInviteExpired   = "invite.expired"
	CodeInviteExhausted = "invite.exhausted"
)

const (
	MessageRequired            = "请先登录共享空间"
	MessageIdentityForbidden   = "该系统身份不能登录共享空间"
	MessageIdentityConflict    = "GitHub 身份与已有账号不一致，请联系空间主人"
	MessageNotInvited          = "该 GitHub 用户尚未被邀请"
	MessageInvalidProfile      = "GitHub 身份信息不完整"
	MessageInvalidState        = "登录状态校验失败"
	MessageGitHubFailed        = "GitHub 登录失败"
	MessageGitHubNotConfigured = "GitHub 登录尚未配置"
	MessageGitHubRequired      = "请通过 GitHub 登录接受邀请"

	MessageInviteInvalid   = "邀请无效或已撤销"
	MessageInviteExpired   = "邀请已过期"
	MessageInviteExhausted = "邀请次数已用完"
)

// Error is the only error shape that an auth HTTP handler may expose. Cause is
// deliberately private to keep SQL/provider details out of public responses.
type Error struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	StatusCode int    `json:"-"`
	Cause      error  `json:"-"`
	Phase      string `json:"-"`
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

func wrapInternal(message string, cause error) *Error {
	return &Error{
		Code:       "internal.error",
		Message:    "服务暂时不可用",
		StatusCode: 500,
		Cause:      fmt.Errorf("%s: %w", message, cause),
	}
}

func isCode(err error, code string) bool {
	var authErr *Error
	return errors.As(err, &authErr) && authErr.Code == code
}

func requiredError() *Error {
	return NewError(CodeRequired, MessageRequired, 401)
}

func invalidProfileError() *Error {
	return NewError(CodeInvalidProfile, MessageInvalidProfile, 400)
}

func invalidStateError() *Error {
	return NewError(CodeInvalidState, MessageInvalidState, 400)
}

func githubFailedError() *Error {
	return NewError(CodeGitHubFailed, MessageGitHubFailed, 502)
}

func githubNotConfiguredError() *Error {
	return NewError(CodeGitHubNotConfigured, MessageGitHubNotConfigured, 503)
}

var (
	// ErrSessionActorUnavailable is returned by a store when the user is not a
	// human active member at session creation time. It maps to auth.required.
	ErrSessionActorUnavailable = NewError(CodeRequired, MessageRequired, 401)
)
