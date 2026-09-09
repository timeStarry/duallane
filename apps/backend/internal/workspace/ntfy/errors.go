package ntfy

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
)

const (
	CodeAuthRequired        = "auth.required"
	CodeIdentityForbidden   = "auth.identity_forbidden"
	CodeTopicGeneration     = "ntfy.topic_generation_failed"
	CodeNotConfigured       = "ntfy.not_configured"
	CodeProviderTimeout     = "ntfy.timeout"
	CodeProviderUnavailable = "ntfy.unavailable"
)

const (
	MessageAuthRequired        = "请先登录共享空间"
	MessageIdentityForbidden   = "该系统身份不能执行用户操作"
	MessageTopicGeneration     = "暂时无法刷新 topic，请稍后重试"
	MessageNotConfigured       = "ntfy 推送尚未配置"
	MessageProviderTimeout     = "ntfy 推送超时"
	MessageProviderUnavailable = "ntfy 推送暂时不可用"
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
	return &Error{Code: "internal.error", Message: "服务暂时不可用", StatusCode: 500, Cause: fmt.Errorf("%s: %w", operation, cause)}
}

func authRequiredError() *Error {
	return NewError(CodeAuthRequired, MessageAuthRequired, 401)
}

func identityForbiddenError() *Error {
	return NewError(CodeIdentityForbidden, MessageIdentityForbidden, 401)
}

func topicGenerationError(cause error) *Error {
	return &Error{Code: CodeTopicGeneration, Message: MessageTopicGeneration, StatusCode: 503, Cause: cause}
}

func notConfiguredError(cause error) *Error {
	return &Error{Code: CodeNotConfigured, Message: MessageNotConfigured, StatusCode: 503, Cause: cause}
}

// ProviderError carries only an upstream status, never an upstream response
// body or request data.
type ProviderError struct {
	StatusCode int
	Timeout    bool
}

func (e *ProviderError) Error() string {
	if e == nil {
		return ""
	}
	if e.Timeout {
		return CodeProviderTimeout
	}
	if e.StatusCode > 0 {
		return fmt.Sprintf("ntfy provider status %d", e.StatusCode)
	}
	return CodeProviderUnavailable
}

func normalizeProviderError(err error) string {
	if err == nil {
		return ""
	}
	var provider *ProviderError
	if errors.As(err, &provider) {
		if provider.Timeout {
			return CodeProviderTimeout
		}
		if provider.StatusCode >= 400 && provider.StatusCode <= 599 {
			return fmt.Sprintf("ntfy.http_%d", provider.StatusCode)
		}
		return CodeProviderUnavailable
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, net.ErrClosed) {
		return CodeProviderTimeout
	}
	var timeout interface{ Timeout() bool }
	if errors.As(err, &timeout) && timeout.Timeout() {
		return CodeProviderTimeout
	}
	if strings.Contains(strings.ToLower(err.Error()), "deadline exceeded") {
		return CodeProviderTimeout
	}
	return CodeProviderUnavailable
}

func normalizeRepositoryError(err error) error {
	if err == nil {
		return nil
	}
	var domainErr *Error
	if errors.As(err, &domainErr) {
		return domainErr
	}
	return internalError("workspace ntfy repository", err)
}
