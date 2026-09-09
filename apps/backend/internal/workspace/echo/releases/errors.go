package releases

import (
	"errors"
	"fmt"
)

const (
	CodePermissionDenied = "echo.release_permission_denied"
	CodeVersionInvalid   = "echo.release_version_invalid"
	CodeGuideInvalid     = "echo.release_guide_invalid"
	CodeGuideNotFound    = "echo.release_guide_not_found"
	CodeNotFound         = "echo.release_not_found"
	CodeInternal         = "internal.error"
)

const (
	MessageUnauthorized     = "无权访问版本更新"
	MessagePermissionDenied = "只有空间主人可以发布版本更新"
	MessageVersionInvalid   = "需要有效的版本号，例如 0.15.1"
	MessageGuideInvalid     = "版本使用指南无效"
	MessageGuideNotFound    = "该版本没有可发布的使用指南"
	MessageNotFound         = "版本更新不存在或不可访问"
	MessageInternal         = "服务暂时不可用"
)

var (
	ErrCatalogInvalid = errors.New("echo release guide catalog is invalid")
	ErrCatalogEmpty   = errors.New("echo release guide catalog is empty")
)

// Error is the only release-domain error intended for transport projection.
// Cause is retained for server diagnostics and is never serialized or exposed
// through Error().
type Error struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	StatusCode int    `json:"-"`
	Cause      error  `json:"-"`
}

// TransactionRejection marks a publish rejection whose metadata-only audit
// has already been written to a caller-owned transaction. The outer caller
// must commit this marker path; database/provider failures remain ordinary
// errors and must roll back.
type TransactionRejection struct {
	Err      *Error
	TargetID string
	Reason   string
}

func (e *TransactionRejection) Error() string {
	if e == nil || e.Err == nil {
		return ""
	}
	return e.Err.Error()
}

func (e *TransactionRejection) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func (e *TransactionRejection) PublicError() *Error {
	if e == nil || e.Err == nil {
		return nil
	}
	return e.Err.Public()
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
	if errors.As(err, &domainErr) && domainErr != nil {
		return domainErr
	}
	return internalError("workspace echo release repository", err)
}

func permissionDeniedError() *Error {
	return NewError(CodePermissionDenied, MessagePermissionDenied, 403)
}

func unauthorizedError() *Error {
	return NewError(CodePermissionDenied, MessageUnauthorized, 403)
}

func guideNotFoundError() *Error {
	return NewError(CodeGuideNotFound, MessageGuideNotFound, 404)
}

func releaseNotFoundError() *Error {
	return NewError(CodeNotFound, MessageNotFound, 404)
}

func validationError(code, message string) *Error {
	return NewError(code, message, 422)
}
