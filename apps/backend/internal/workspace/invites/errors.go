package invites

import (
	"errors"
	"fmt"
)

const (
	CodeAuthRequired     = "auth.required"
	CodePermissionDenied = "permission.denied"
	CodeRoleInvalid      = "role.invalid"
	CodeInviteInvalid    = "invite.invalid"
	CodeInviteNotFound   = "invite.not_found"
	CodeInternal         = "internal.error"
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
		cause = errors.New("unknown error")
	}
	return &Error{Code: CodeInternal, Message: "服务暂时不可用", StatusCode: 500, Cause: fmt.Errorf("%s: %w", operation, cause)}
}

func normalizeError(err error) error {
	if err == nil {
		return nil
	}
	var domainError *Error
	if errors.As(err, &domainError) {
		return domainError
	}
	return internalError("workspace invite repository", err)
}
