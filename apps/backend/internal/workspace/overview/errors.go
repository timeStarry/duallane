package overview

import (
	"errors"
	"fmt"
)

const (
	CodeAuthRequired      = "auth.required"
	CodeIdentityForbidden = "auth.identity_forbidden"
	CodePermissionDenied  = "permission.denied"
	CodeInvalidTime       = "statistics.invalid_time"
	CodeInternal          = "internal.error"
)

const (
	MessageAuthRequired      = "请先登录共享空间"
	MessageIdentityForbidden = "该系统身份不能执行用户操作"
	MessagePermissionDenied  = "你没有执行该操作的权限"
	MessageInvalidTime       = "统计时间无效"
	MessageInternal          = "服务暂时不可用"
)

type Error struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	StatusCode int    `json:"-"`
	Cause      error  `json:"-"`
}

func (err *Error) Error() string {
	if err == nil {
		return ""
	}
	return err.Code
}

func (err *Error) Unwrap() error {
	if err == nil {
		return nil
	}
	return err.Cause
}

func NewError(code, message string, status int) *Error {
	return &Error{Code: code, Message: message, StatusCode: status}
}

func internalError(operation string, cause error) *Error {
	if cause == nil {
		cause = errors.New(operation)
	}
	return &Error{Code: CodeInternal, Message: MessageInternal, StatusCode: 500, Cause: fmt.Errorf("%s: %w", operation, cause)}
}
