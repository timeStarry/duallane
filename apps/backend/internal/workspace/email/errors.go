package email

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
)

const (
	CodeAuthRequired           = "auth.required"
	CodeIdentityForbidden      = "auth.identity_forbidden"
	CodePermissionDenied       = "permission.denied"
	CodeInvalidEmail           = "email.invalid"
	CodeSMTPInvalid            = "email.smtp_invalid"
	CodeSMTPAuthInvalid        = "email.smtp_auth_invalid"
	CodeSMTPTestRequired       = "email.smtp_test_required"
	CodeSMTPTestRateLimited    = "email.smtp_test_rate_limited"
	CodeEncryptionUnconfigured = "email.encryption_not_configured"
	CodeCredentialUnavailable  = "email.credential_unavailable"
	CodeRecipientUnverified    = "email.recipient_unverified"
	CodeSMTPUnavailable        = "email.smtp_unavailable"
	CodeVerificationRateLimit  = "email.verification_rate_limited"
	CodeVerificationResend     = "email.verification_resend_later"
	CodeVerificationInvalid    = "email.verification_invalid"
	CodeGitHubUnavailable      = "email.github_unavailable"
	CodeSMTPAuthFailed         = "email.smtp_auth_failed"
	CodeSMTPTimeout            = "email.smtp_timeout"
	CodeSMTPUnreachable        = "email.smtp_unreachable"
	CodeSMTPFailed             = "email.smtp_failed"
)

const (
	MessageAuthRequired          = "请先登录共享空间"
	MessageIdentityForbidden     = "该系统身份不能执行用户操作"
	MessagePermissionDenied      = "你没有执行该操作的权限"
	MessageInvalidEmail          = "请输入有效的邮箱地址"
	MessageSMTPInvalid           = "请填写有效的 SMTP 服务器和端口"
	MessageSMTPAuthInvalid       = "SMTP 用户名和密码需要同时填写"
	MessageSMTPTestRequired      = "请先测试当前邮件配置"
	MessageSMTPTestRateLimited   = "测试过于频繁，请稍后再试"
	MessageEncryptionMissing     = "邮件凭据加密密钥尚未配置"
	MessageCredentialUnavailable = "邮件凭据无法读取"
	MessageRecipientUnverified   = "请先设置并验证通知邮箱"
	MessageSMTPUnavailable       = "空间邮件通知尚未启用"
	MessageVerificationRate      = "验证码发送过于频繁，请稍后再试"
	MessageVerificationResend    = "请稍后再发送验证码"
	MessageVerificationInvalid   = "验证码无效或已过期"
	MessageGitHubUnavailable     = "GitHub 账号没有可用邮箱"
	MessageSMTPAuthFailed        = "SMTP 身份验证失败"
	MessageSMTPTimeout           = "SMTP 连接超时"
	MessageSMTPUnreachable       = "无法连接 SMTP 服务器"
	MessageSMTPFailed            = "测试邮件发送失败"
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

func newError(code, message string, status int) *Error {
	return &Error{Code: code, Message: message, StatusCode: status}
}

func internalError(operation string, cause error) *Error {
	if cause == nil {
		cause = errors.New(operation)
	}
	return &Error{Code: "internal.error", Message: "服务暂时不可用", StatusCode: 500, Cause: fmt.Errorf("%s: %w", operation, cause)}
}

func normalizeRepositoryError(err error) error {
	if err == nil {
		return nil
	}
	var domainErr *Error
	if errors.As(err, &domainErr) {
		return domainErr
	}
	return internalError("workspace email repository", err)
}

type ProviderError struct {
	Code    string
	Timeout bool
}

func (e *ProviderError) Error() string {
	if e == nil || e.Code == "" {
		return CodeSMTPFailed
	}
	return e.Code
}

func normalizeMailerError(err error) string {
	if err == nil {
		return ""
	}
	var emailErr *Error
	if errors.As(err, &emailErr) && emailErr != nil && strings.HasPrefix(emailErr.Code, "email.") {
		return emailErr.Code
	}
	var provider *ProviderError
	if errors.As(err, &provider) && provider != nil && provider.Code != "" {
		return provider.Code
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return CodeSMTPTimeout
	}
	var timeout interface{ Timeout() bool }
	if errors.As(err, &timeout) && timeout.Timeout() {
		return CodeSMTPTimeout
	}
	var netErr *net.OpError
	if errors.As(err, &netErr) {
		if netErr.Timeout() {
			return CodeSMTPTimeout
		}
		return CodeSMTPUnreachable
	}
	code := strings.ToUpper(strings.TrimSpace(errorCode(err)))
	switch code {
	case "EAUTH", "EENVELOPE", "535", "AUTH":
		return CodeSMTPAuthFailed
	case "ETIMEDOUT", "ESOCKET":
		return CodeSMTPTimeout
	case "ECONNECTION", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN":
		return CodeSMTPUnreachable
	default:
		return CodeSMTPFailed
	}
}

type codedError interface{ Code() string }

func errorCode(err error) string {
	var coded codedError
	if errors.As(err, &coded) {
		return coded.Code()
	}
	return ""
}

func smtpErrorMessage(code string) string {
	switch code {
	case CodeSMTPAuthFailed:
		return MessageSMTPAuthFailed
	case CodeSMTPTimeout:
		return MessageSMTPTimeout
	case CodeSMTPUnreachable:
		return MessageSMTPUnreachable
	default:
		return MessageSMTPFailed
	}
}

func normalizeErrorCode(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 128 {
		return CodeSMTPFailed
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f || r == '\n' || r == '\r' {
			return CodeSMTPFailed
		}
	}
	return value
}
