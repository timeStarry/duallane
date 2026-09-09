package avatars

import (
	"errors"
	"fmt"
)

const (
	CodeAvatarInvalid               = "avatar.invalid"
	CodeAvatarUnsupportedFormat     = "avatar.unsupported_format"
	CodeAvatarInvalidSize           = "avatar.invalid_size"
	CodeAvatarInvalidImage          = "avatar.invalid_image"
	CodeAvatarProcessingFailed      = "avatar.processing_failed"
	CodeAvatarProcessingUnavailable = "avatar.processing_unavailable"
	CodeAvatarStorageFailed         = "avatar.storage_failed"
	CodeAvatarNotFound              = "avatar.not_found"
	CodeAuthRequired                = "auth.required"
	CodeIdentityForbidden           = "auth.identity_forbidden"
	CodeInternal                    = "internal.error"
)

const (
	MessageAvatarInvalid               = "头像数据无效"
	MessageAvatarUnsupportedFormat     = "头像仅支持 JPEG、PNG 或 WebP"
	MessageAvatarInvalidSize           = "头像文件大小应在 5 MiB 以内"
	MessageAvatarSizeMismatch          = "头像文件大小与请求不一致"
	MessageAvatarInvalidImage          = "头像图片无法解析"
	MessageAvatarInvalidDimensions     = "头像图片尺寸或格式无效"
	MessageAvatarProcessingFailed      = "头像处理失败"
	MessageAvatarProcessingUnavailable = "头像处理服务不可用"
	MessageAvatarStorageFailed         = "头像保存失败"
	MessageAvatarNotFound              = "头像不存在"
	MessageAuthRequired                = "请先登录共享空间"
	MessageIdentityForbidden           = "该系统身份不能执行用户操作"
	MessageInternal                    = "服务暂时不可用"
)

// Error is the safe domain error shape for the eventual HTTP adapter. Cause
// is retained for server diagnostics and deliberately excluded from JSON.
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

func avatarNotFoundError() *Error {
	return NewError(CodeAvatarNotFound, MessageAvatarNotFound, 404)
}

func normalizeRepositoryError(err error) error {
	if err == nil {
		return nil
	}
	var value *Error
	if errors.As(err, &value) {
		return value
	}
	return internalError("workspace avatar repository", err)
}
