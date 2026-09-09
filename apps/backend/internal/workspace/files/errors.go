package files

import (
	"errors"
	"fmt"
)

const (
	CodeAuthRequired          = "auth.required"
	CodeIdentityForbidden     = "auth.identity_forbidden"
	CodePermissionDenied      = "permission.denied"
	CodeFileInvalid           = "file.invalid"
	CodeFileInvalidSize       = "file.invalid_size"
	CodeFileInvalidVisibility = "file.invalid_visibility"
	CodeFileNotFound          = "file.not_found"
	CodeFileStorageMissing    = "file.storage_missing"
	CodeFileStorageMismatch   = "file.storage_mismatch"
	CodeFileStorageTooLarge   = "file.storage_too_large"
	CodeQuotaInsufficient     = "quota.insufficient"
	CodeUploadInvalid         = "upload.invalid"
	CodeUploadInvalidContent  = "upload.invalid_content"
	CodeUploadSizeMismatch    = "upload.size_mismatch"
	CodeUploadHashMismatch    = "upload.hash_mismatch"
	CodeUploadInvalidPart     = "upload.invalid_part"
	CodeUploadInvalidPartHash = "upload.invalid_part_hash"
	CodeUploadPartSize        = "upload.part_size_mismatch"
	CodeUploadPartHash        = "upload.part_hash_mismatch"
	CodeUploadPartConflict    = "upload.part_conflict"
	CodeUploadPartsIncomplete = "upload.parts_incomplete"
	CodeDownloadInvalid       = "download.invalid"
	CodeDownloadExpired       = "download.expired"
	CodeInternal              = "internal.error"
)

const (
	MessageAuthRequired          = "请先登录共享空间"
	MessageIdentityForbidden     = "该系统身份不能执行用户操作"
	MessagePermissionDenied      = "你没有执行该操作的权限"
	MessageFileInvalid           = "文件参数无效"
	MessageFileInvalidSize       = "文件大小无效"
	MessageFileInvalidVisibility = "文件可见性无效"
	MessageFileNotFound          = "文件不存在或不可下载"
	MessageFileStorageMissing    = "文件内容不可用"
	MessageFileStorageMismatch   = "文件内容不可用"
	MessageFileStorageTooLarge   = "文件内容过大"
	MessageQuotaInsufficient     = "今日传输额度不足"
	MessageUploadInvalid         = "上传预留不存在或状态不可用"
	MessageUploadInvalidContent  = "上传内容不能为空"
	MessageUploadSizeMismatch    = "上传内容大小与预留不一致"
	MessageUploadHashMismatch    = "上传内容校验失败"
	MessageUploadInvalidPart     = "上传分片编号无效"
	MessageUploadPartSize        = "上传分片大小不正确"
	MessageUploadPartHash        = "上传分片校验失败"
	MessageUploadPartConflict    = "该分片已上传且内容不同"
	MessageUploadPartsIncomplete = "上传分片不完整"
	MessageDownloadInvalid       = "下载预留不存在或已失效"
	MessageDownloadExpired       = "下载链接已失效，请重新下载"
	MessageInternal              = "服务暂时不可用"
)

// Error is the only public error shape the eventual HTTP adapter should
// expose. Cause is retained for server-side diagnostics and never serialized.
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

func isCode(err error, code string) bool {
	var value *Error
	return errors.As(err, &value) && value.Code == code
}

func normalizeRepositoryError(err error) error {
	if err == nil {
		return nil
	}
	var value *Error
	if errors.As(err, &value) {
		return value
	}
	return internalError("workspace file repository", err)
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

func fileNotFoundError() *Error {
	// Node's WorkspaceValidationError uses the default 400 status for logical
	// file-not-found cases (download/preview/reserve/remove). Physical object
	// absence remains CodeFileStorageMissing with its own storage status.
	return NewError(CodeFileNotFound, MessageFileNotFound, 400)
}

func conversationNotFoundError() *Error {
	return NewError("conversation.not_found", "你无法访问此会话", 403)
}

func validationError(code, message string) *Error {
	return NewError(code, message, 400)
}

func uploadInvalidError() *Error {
	return NewError(CodeUploadInvalid, MessageUploadInvalid, 400)
}

func downloadInvalidError() *Error {
	return NewError(CodeDownloadInvalid, MessageDownloadInvalid, 400)
}

func downloadExpiredError() *Error {
	return NewError(CodeDownloadExpired, MessageDownloadExpired, 400)
}
