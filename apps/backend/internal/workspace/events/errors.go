package events

import (
	"errors"
	"fmt"
)

const (
	CodeAuthRequired      = "auth.required"
	CodeIdentityForbidden = "auth.identity_forbidden"
	CodeSequenceInvalid   = "realtime.sequence_invalid"
	CodeInternal          = "internal.error"
)

const (
	MessageAuthRequired      = "请先登录共享空间"
	MessageIdentityForbidden = "该系统身份不能执行用户操作"
	MessageSequenceInvalid   = "实时同步游标无效"
	MessageInternal          = "服务暂时不可用"
)

// Error is the safe transport error for read/replay failures. Cause remains
// private so SQL details never enter a realtime or HTTP response.
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

func sequenceInvalidError() *Error {
	return NewError(CodeSequenceInvalid, MessageSequenceInvalid, 400)
}

func normalizeError(err error) error {
	if err == nil {
		return nil
	}
	var domainErr *Error
	if errors.As(err, &domainErr) {
		return domainErr
	}
	return internalError("workspace event repository", err)
}
