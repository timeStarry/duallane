// Package storage contains trust-lane-neutral bounded blob operations.
// Workspace authorization and logical object ownership stay in the files
// domain; this package only validates physical keys and bytes.
package storage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const (
	CanonicalObjectPrefix       = "workspace/objects/sha256/"
	DefaultMaxObjectBytes int64 = 2 * 1024 * 1024 * 1024
)

// Object is the physical identity expected by a BlobStore. Key is internal
// and must never be projected as a public file field.
type Object struct {
	Key         string
	SHA256      string
	ByteSize    int64
	ContentType string
}

// StoredObject describes bytes accepted by Put. Reused reports that an
// existing immutable file already matched the requested identity.
type StoredObject struct {
	Object
	Reused bool
}

// OpenedObject is returned only after the adapter has validated the object
// metadata and content. The caller owns Body and must close it.
type OpenedObject struct {
	Object
	Body io.ReadCloser
}

// BlobStore is deliberately small so an S3 adapter can be added without
// leaking provider types into the Workspace files service.
type BlobStore interface {
	Put(ctx context.Context, key string, source io.Reader, expectedSize int64, expectedSHA256 string) (StoredObject, error)
	Open(ctx context.Context, object Object, maxBytes int64) (OpenedObject, error)
	Delete(ctx context.Context, object Object) error
}

// Error is the safe physical-storage error shape. Path, credentials, provider
// responses, and hashes are kept out of its public message.
type Error struct {
	Code       string
	Message    string
	StatusCode int
	Cause      error
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

func newError(code, message string, status int, cause error) *Error {
	return &Error{Code: code, Message: message, StatusCode: status, Cause: cause}
}

func internalError(operation string, cause error) *Error {
	if cause == nil {
		cause = errors.New(operation)
	}
	return newError("internal.error", "服务暂时不可用", 500, fmt.Errorf("%s: %w", operation, cause))
}

// CanonicalObjectKey returns the stable digest-addressed key shared by local
// and future S3 adapters. It contains no user, space, filename, or MIME data.
func CanonicalObjectKey(digest string) (string, error) {
	digest, err := NormalizeSHA256(digest)
	if err != nil {
		return "", err
	}
	return CanonicalObjectPrefix + digest[:2] + "/" + digest, nil
}

// NormalizeSHA256 validates and canonicalizes a lowercase hexadecimal digest.
func NormalizeSHA256(value string) (string, error) {
	digest := strings.ToLower(strings.TrimSpace(value))
	if len(digest) != sha256.Size*2 {
		return "", newError("storage.object_invalid_digest", "存储对象摘要无效", 500, errors.New("sha256 length is invalid"))
	}
	if _, err := hex.DecodeString(digest); err != nil {
		return "", newError("storage.object_invalid_digest", "存储对象摘要无效", 500, err)
	}
	return digest, nil
}

// ValidateCanonicalKey rejects a registry key that does not correspond to the
// digest. Registry rows are not allowed to redirect reads to arbitrary paths.
func ValidateCanonicalKey(key, digest string) error {
	expected, err := CanonicalObjectKey(digest)
	if err != nil {
		return err
	}
	if strings.TrimSpace(key) != expected {
		return newError("storage.object_invalid_key", "存储对象路径无效", 500, errors.New("canonical key mismatch"))
	}
	return nil
}

func isCanonicalKey(key string) bool {
	return strings.HasPrefix(strings.ReplaceAll(key, "\\", "/"), CanonicalObjectPrefix)
}

func validateByteSize(value int64, allowEmpty bool) error {
	if value < 0 || (!allowEmpty && value == 0) {
		return newError("storage.object_invalid_size", "存储对象大小无效", 500, errors.New("byte size is invalid"))
	}
	if value > DefaultMaxObjectBytes {
		return newError("storage.object_too_large", "文件内容过大", 413, errors.New("byte size exceeds adapter limit"))
	}
	return nil
}

func validateExpectedHash(value string) (string, error) {
	if strings.TrimSpace(value) == "" {
		return "", nil
	}
	return NormalizeSHA256(value)
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(p)
}

func copyAndHash(ctx context.Context, destination io.Writer, source io.Reader, expectedSize int64) (int64, string, error) {
	if source == nil {
		return 0, "", newError("upload.invalid_content", "上传内容不能为空", 400, errors.New("source is nil"))
	}
	if err := validateByteSize(expectedSize, true); err != nil {
		return 0, "", err
	}
	hash := sha256.New()
	limited := io.LimitReader(contextReader{ctx: ctx, r: source}, expectedSize+1)
	writer := io.MultiWriter(destination, hash)
	written, err := io.Copy(writer, limited)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return written, "", err
		}
		return written, "", internalError("write object", err)
	}
	if written != expectedSize {
		return written, "", newError("upload.size_mismatch", "上传内容大小与预留不一致", 400, errors.New("source size mismatch"))
	}
	return written, hex.EncodeToString(hash.Sum(nil)), nil
}

func validateReaderLimit(maxBytes, byteSize int64) error {
	if maxBytes <= 0 {
		maxBytes = DefaultMaxObjectBytes
	}
	if byteSize < 0 || byteSize > maxBytes {
		return newError("file.storage_too_large", "文件内容过大", 413, errors.New("object exceeds read limit"))
	}
	return nil
}

func cleanRoot(root string) (string, error) {
	if strings.TrimSpace(root) == "" {
		return "", errors.New("storage root is required")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("resolve storage root: %w", err)
	}
	return filepath.Clean(abs), nil
}

func resolveContainedPath(root, key string) (string, error) {
	if strings.TrimSpace(key) == "" || strings.ContainsRune(key, '\x00') {
		return "", newError("storage.invalid_key", "文件存储路径无效", 500, errors.New("empty or NUL key"))
	}
	// Treat Windows separators as separators on every platform so traversal
	// attempts cannot become valid merely because the service runs on Linux.
	key = strings.ReplaceAll(key, "\\", "/")
	if filepath.IsAbs(key) || isAbsoluteObjectKey(key) {
		return "", newError("storage.invalid_key", "文件存储路径无效", 500, errors.New("absolute key"))
	}
	for _, segment := range strings.Split(key, "/") {
		if segment == ".." {
			return "", newError("storage.invalid_key", "文件存储路径无效", 500, errors.New("traversal segment"))
		}
	}
	target := filepath.Clean(filepath.Join(root, filepath.FromSlash(key)))
	relative, err := filepath.Rel(root, target)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", newError("storage.invalid_key", "文件存储路径无效", 500, errors.New("path escapes root"))
	}
	return target, nil
}

func isAbsoluteObjectKey(key string) bool {
	if strings.HasPrefix(key, "//") {
		return true
	}
	return len(key) >= 2 && key[1] == ':'
}

func ensureNoSymlink(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return newError("storage.invalid_key", "文件存储路径无效", 500, errors.New("symlink is not allowed"))
	}
	return nil
}
