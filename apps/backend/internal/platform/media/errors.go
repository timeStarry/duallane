// Package media contains the compatibility-tested Workspace image boundary.
// It accepts bounded image bytes and returns normalized, metadata-free WebP
// bytes. Authorization, storage, and logical ownership stay outside this
// package.
package media

import (
	"errors"
	"fmt"
)

const (
	CodeInvalidSource         = "media.invalid_source"
	CodeInvalidLimits         = "media.invalid_limits"
	CodeProcessingUnavailable = "media.processing_unavailable"
)

// Error is the safe error shape returned by the media boundary. Cause is kept
// for internal wrapping and is never included in the public projection.
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

// Public returns a copy without implementation details.
func (e *Error) Public() *Error {
	if e == nil {
		return nil
	}
	return &Error{Code: e.Code, Message: e.Message, StatusCode: e.StatusCode}
}

func mediaError(code, message string, status int, cause error) *Error {
	return &Error{Code: code, Message: message, StatusCode: status, Cause: cause}
}

func invalidLimitsError(cause error) *Error {
	if cause == nil {
		cause = errors.New("media limits are invalid")
	}
	return mediaError(CodeInvalidLimits, "媒体处理限制无效", 500, cause)
}

func unavailableError(cause error) *Error {
	if cause == nil {
		cause = errors.New("libvips is unavailable")
	}
	return mediaError(CodeProcessingUnavailable, "媒体处理服务不可用", 503, fmt.Errorf("libvips: %w", cause))
}
