package emotes

import (
	"errors"
	"fmt"
)

const (
	CodeAuthRequired                 = "auth.required"
	CodeIdentityForbidden            = "auth.identity_forbidden"
	CodePermissionDenied             = "permission.denied"
	CodeEmoteInvalidFormat           = "emote.invalid_format"
	CodeEmoteDecodeFailed            = "emote.decode_failed"
	CodeEmoteInvalidContent          = "emote.invalid_content"
	CodeEmoteInputTooLarge           = "emote.input_too_large"
	CodeEmoteOutputTooLarge          = "emote.output_too_large"
	CodeEmoteDimensionsExceeded      = "emote.dimensions_exceeded"
	CodeEmoteAnimationTooComplex     = "emote.animation_too_complex"
	CodeEmoteProcessFailed           = "emote.process_failed"
	CodeEmoteProcessingUnavailable   = "emote.processing_unavailable"
	CodeEmoteInvalidFileName         = "emote.invalid_file_name"
	CodeEmoteInvalidLabel            = "emote.invalid_label"
	CodeEmoteInvalidSettings         = "emote.invalid_settings"
	CodeEmotePackRequired            = "emote.pack_required"
	CodeEmoteInvalidOrder            = "emote.invalid_order"
	CodeEmoteInvalidCollectionName   = "emote.invalid_collection_name"
	CodeEmoteCollectionNotFound      = "emote.collection_not_found"
	CodeEmoteCollectionEmpty         = "emote.collection_empty"
	CodeEmoteCollectionLimitReached  = "emote.collection_limit_reached"
	CodeEmoteStorageLimitReached     = "emote.storage_limit_reached"
	CodeEmoteSubscriptionReadOnly    = "emote.subscription_read_only"
	CodeEmoteShareNotFound           = "emote.share_not_found"
	CodeEmoteShareRevoked            = "emote.share_revoked"
	CodeEmoteInvalidSource           = "emote.invalid_source"
	CodeEmoteNotFound                = "emote.not_found"
	CodeEmoteStorageMissing          = "emote.storage_missing"
	CodeEmoteInvalidReference        = "emote.invalid_reference"
	CodeEmoteSubscriptionUnsupported = "emote.subscription_unsupported"
	CodeEmoteInvalidSubscription     = "emote.invalid_subscription"
	CodeInternal                     = "internal.error"
)

const (
	MessageAuthRequired                 = "请先登录共享空间"
	MessageIdentityForbidden            = "该系统身份不能执行用户操作"
	MessagePermissionDenied             = "你没有执行该操作的权限"
	MessageEmoteInvalidFormat           = "仅支持 JPEG、PNG、WebP、GIF 或 BMP 图片"
	MessageEmoteDecodeFailed            = "图片无法解析"
	MessageEmoteInvalidContent          = "表情图片不能为空"
	MessageEmoteInputTooLarge           = "表情原图不能超过 10 MiB"
	MessageEmoteOutputTooLarge          = "压缩后的表情仍然过大"
	MessageEmoteDimensionsExceeded      = "图片尺寸过大"
	MessageEmoteAnimationTooComplex     = "动图帧数或时长超出限制"
	MessageEmoteProcessFailed           = "表情图片处理失败"
	MessageEmoteProcessingUnavailable   = "表情图片处理暂不可用"
	MessageEmoteInvalidFileName         = "表情文件名无效"
	MessageEmoteInvalidLabel            = "表情名称应为 1 至 16 个有效字符"
	MessageEmoteInvalidSettings         = "图片表情设置无效"
	MessageEmotePackRequired            = "至少保留一个表情包"
	MessageEmoteInvalidOrder            = "表情顺序无效"
	MessageEmoteInvalidCollectionName   = "合集名称需为 1 至 32 个字符"
	MessageEmoteCollectionNotFound      = "表情合集不存在"
	MessageEmoteCollectionEmpty         = "空合集不能分享"
	MessageEmoteCollectionLimitReached  = "合集已达到 100 张上限"
	MessageEmoteStorageLimitReached     = "收藏表情空间已满"
	MessageEmoteSubscriptionReadOnly    = "订阅中的合集为只读"
	MessageEmoteShareNotFound           = "分享不存在"
	MessageEmoteShareRevoked            = "该合集已停止分享"
	MessageEmoteInvalidSource           = "收藏表情已不可用"
	MessageEmoteNotFound                = "收藏表情不存在"
	MessageEmoteStorageMissing          = "收藏表情内容不可用"
	MessageEmoteInvalidReference        = "表情引用无效"
	MessageEmoteSubscriptionUnsupported = "表情合集订阅由后续迁移负责"
	MessageEmoteInvalidSubscription     = "订阅设置无效"
	MessageInternal                     = "服务暂时不可用"
)

// Error is the only error shape an eventual Workspace transport should
// expose. Cause stays private so database, storage, and processor details do
// not cross the HTTP boundary.
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
	return internalError("workspace emote repository", err)
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

func validationError(code, message string) *Error {
	return NewError(code, message, 400)
}

func conflictError(code, message string) *Error {
	return NewError(code, message, 409)
}

func notFoundError(code, message string) *Error {
	return NewError(code, message, 404)
}

func isCode(err error, code string) bool {
	var domainErr *Error
	return errors.As(err, &domainErr) && domainErr.Code == code
}
