package files

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

const (
	legacyAttachmentSegmentMaxBytes = 128
	legacyStorageNameMaxBytes       = 120
)

// openAttachmentRecord is the only physical read path used by previews and
// completed downloads. Authorization and, for downloads, the logical grant
// are checked by the caller before this method is reached. A live registry
// object is authoritative: only an explicit object-not-found result permits
// trying the legacy compatibility keys.
func (s *Service) openAttachmentRecord(ctx context.Context, record AttachmentRecord, maxBytes int64, operation string) (platformstorage.OpenedObject, error) {
	if s == nil {
		return platformstorage.OpenedObject{}, internalError(operation, errors.New("files service is required"))
	}
	readLimit, err := attachmentReadLimit(record.ByteSize, maxBytes)
	if err != nil {
		return platformstorage.OpenedObject{}, err
	}

	// Node's attachment projection joins only non-deleted registry rows. If a
	// Go projection exposes a tombstoned object (or keeps its object ID while
	// the non-deleted join is absent), that is an inconsistent bound state, not
	// an unbound legacy record. Failing closed prevents a deleted canonical
	// binding from resurrecting stale bytes under an old key.
	if record.StorageObjectID != "" && record.StorageObject == nil {
		return platformstorage.OpenedObject{}, fileStorageMismatchError()
	}
	if object := record.StorageObject; object != nil {
		if object.DeletedAt != nil {
			return platformstorage.OpenedObject{}, fileStorageMismatchError()
		}
		if object.ByteSize != record.ByteSize {
			return platformstorage.OpenedObject{}, fileStorageMismatchError()
		}
		// The registry must not redirect a read to a non-content-addressed key,
		// even if a future BlobStore implementation would otherwise accept it.
		if err := platformstorage.ValidateCanonicalKey(object.ObjectKey, object.SHA256); err != nil {
			return platformstorage.OpenedObject{}, fileStorageMismatchError()
		}
		if s.blobStore == nil {
			return platformstorage.OpenedObject{}, internalError(operation, errors.New("blob store is required for a bound object"))
		}
		opened, openErr := s.blobStore.Open(ctx, object.BlobObject(), readLimit)
		if openErr == nil {
			return validateOpenedAttachment(ctx, opened, object.ObjectKey, record.ByteSize, record.MIMEType, "")
		}
		closeOpenedObject(opened)
		if !isMissingAttachmentObject(openErr) {
			return platformstorage.OpenedObject{}, normalizeAttachmentOpenError(openErr)
		}
		return s.openLegacyAttachment(ctx, record, readLimit, object.SHA256)
	}

	return s.openLegacyAttachment(ctx, record, readLimit, "")
}

func (s *Service) openLegacyAttachment(ctx context.Context, record AttachmentRecord, maxBytes int64, expectedSHA256 string) (platformstorage.OpenedObject, error) {
	keys := legacyAttachmentStorageKeys(record, s.space())
	if len(keys) == 0 || s.legacyReader == nil {
		return platformstorage.OpenedObject{}, NewError(CodeFileStorageMissing, MessageFileStorageMissing, 404)
	}
	for _, key := range keys {
		opened, err := s.legacyReader.OpenLegacy(ctx, key, maxBytes)
		if err != nil {
			closeOpenedObject(opened)
			if !isMissingAttachmentObject(err) {
				return platformstorage.OpenedObject{}, normalizeAttachmentOpenError(err)
			}
			continue
		}
		return validateOpenedAttachment(ctx, opened, key, record.ByteSize, record.MIMEType, expectedSHA256)
	}
	return platformstorage.OpenedObject{}, NewError(CodeFileStorageMissing, MessageFileStorageMissing, 404)
}

func attachmentReadLimit(expectedSize, maxBytes int64) (int64, error) {
	if expectedSize < 0 {
		return 0, fileStorageMismatchError()
	}
	if expectedSize > platformstorage.DefaultMaxObjectBytes {
		return 0, NewError(CodeFileStorageTooLarge, MessageFileStorageTooLarge, 413)
	}
	if maxBytes <= 0 || maxBytes > platformstorage.DefaultMaxObjectBytes {
		maxBytes = platformstorage.DefaultMaxObjectBytes
	}
	if expectedSize > maxBytes {
		return 0, NewError(CodeFileStorageTooLarge, MessageFileStorageTooLarge, 413)
	}
	return maxBytes, nil
}

func validateOpenedAttachment(ctx context.Context, opened platformstorage.OpenedObject, expectedKey string, expectedSize int64, contentType, expectedSHA256 string) (platformstorage.OpenedObject, error) {
	if opened.Body == nil {
		return platformstorage.OpenedObject{}, fileStorageMismatchError()
	}
	if opened.Key != expectedKey || opened.ByteSize != expectedSize || opened.ByteSize < 0 || opened.ByteSize > platformstorage.DefaultMaxObjectBytes {
		closeOpenedObject(opened)
		return platformstorage.OpenedObject{}, fileStorageMismatchError()
	}
	if strings.TrimSpace(expectedSHA256) != "" {
		expectedDigest, expectedErr := platformstorage.NormalizeSHA256(expectedSHA256)
		actualDigest, actualErr := platformstorage.NormalizeSHA256(opened.SHA256)
		if expectedErr != nil {
			closeOpenedObject(opened)
			return platformstorage.OpenedObject{}, fileStorageMismatchError()
		}
		if actualErr == nil {
			if expectedDigest != actualDigest {
				closeOpenedObject(opened)
				return platformstorage.OpenedObject{}, fileStorageMismatchError()
			}
			opened.SHA256 = expectedDigest
		} else if strings.TrimSpace(opened.SHA256) == "" {
			// Legacy S3 objects may predate digest metadata. The platform
			// adapter has already bounded the stream and verified its size;
			// hash the bytes as the caller consumes them so this compatibility
			// path remains streaming and does not require a memory buffer.
			opened.SHA256 = expectedDigest
			opened.Body = newLegacyDigestReadCloser(ctx, opened.Body, expectedSize, expectedDigest)
		} else {
			closeOpenedObject(opened)
			return platformstorage.OpenedObject{}, fileStorageMismatchError()
		}
	}
	if strings.TrimSpace(opened.ContentType) == "" {
		opened.ContentType = strings.TrimSpace(contentType)
		if opened.ContentType == "" {
			opened.ContentType = "application/octet-stream"
		}
	}
	return opened, nil
}

type legacyDigestReadCloser struct {
	ctx      context.Context
	body     io.ReadCloser
	expected int64
	digest   string
	count    int64
	hash     hash.Hash
	terminal error
	closed   bool
}

func newLegacyDigestReadCloser(ctx context.Context, body io.ReadCloser, expected int64, digest string) io.ReadCloser {
	return &legacyDigestReadCloser{ctx: ctx, body: body, expected: expected, digest: digest, hash: sha256.New()}
}

func (r *legacyDigestReadCloser) Read(p []byte) (int, error) {
	if r.terminal != nil {
		return 0, r.terminal
	}
	if r.ctx != nil {
		if err := r.ctx.Err(); err != nil {
			return 0, r.fail(err)
		}
	}
	n, err := r.body.Read(p)
	if n > 0 {
		remaining := r.expected - r.count
		if remaining < int64(n) {
			allowed := remaining
			if allowed < 0 {
				allowed = 0
			}
			if allowed > 0 {
				_, _ = r.hash.Write(p[:allowed])
				r.count += allowed
			}
			return int(allowed), r.fail(fileStorageMismatchError())
		}
		_, _ = r.hash.Write(p[:n])
		r.count += int64(n)
	}
	if err == nil {
		return n, nil
	}
	if errors.Is(err, io.EOF) {
		if r.count != r.expected || hex.EncodeToString(r.hash.Sum(nil)) != r.digest {
			return n, r.fail(fileStorageMismatchError())
		}
		r.terminal = io.EOF
		return n, io.EOF
	}
	return n, r.fail(err)
}

func (r *legacyDigestReadCloser) fail(err error) error {
	if r.terminal != nil {
		return r.terminal
	}
	_ = r.body.Close()
	r.closed = true
	r.terminal = err
	return err
}

func (r *legacyDigestReadCloser) Close() error {
	if r.closed {
		return nil
	}
	r.closed = true
	return r.body.Close()
}

func normalizeAttachmentOpenError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	var storageErr *platformstorage.Error
	if errors.As(err, &storageErr) && storageErr != nil {
		switch storageErr.Code {
		case "file.storage_missing":
			return NewError(CodeFileStorageMissing, MessageFileStorageMissing, 404)
		case "file.storage_mismatch":
			return fileStorageMismatchError()
		case "file.storage_too_large":
			return NewError(CodeFileStorageTooLarge, MessageFileStorageTooLarge, 413)
		}
	}
	return normalizeStorageError(err)
}

func isMissingAttachmentObject(err error) bool {
	var storageErr *platformstorage.Error
	return errors.As(err, &storageErr) && storageErr != nil && storageErr.Code == "file.storage_missing"
}

func fileStorageMismatchError() *Error {
	return NewError(CodeFileStorageMismatch, MessageFileStorageMismatch, 500)
}

func closeOpenedObject(opened platformstorage.OpenedObject) {
	if opened.Body != nil {
		_ = opened.Body.Close()
	}
}

// legacyAttachmentStorageKeys returns only keys derived from the authorized
// attachment identity. The old local layout is retained for existing files;
// the deterministic attachment layout is also tried because the Node S3
// adapter uses it for legacy reads and may use the old key only for local
// fallback. An unrecognized stored key is never passed to an adapter.
func legacyAttachmentStorageKeys(record AttachmentRecord, spaceID string) []string {
	if record.SpaceID != spaceID || !validLegacySegment(record.SpaceID) || !validLegacySegment(record.ID) || !utf8.ValidString(record.FileName) {
		return nil
	}
	oldKey := fmt.Sprintf("workspace/%s/%s/%s", record.SpaceID, record.ID, nodeSafeStorageName(record.FileName))
	deterministicKey := fmt.Sprintf("workspace/attachments/%s/%s/content", record.SpaceID, record.ID)
	storedKey := record.StorageKey
	switch storedKey {
	case "":
		return []string{oldKey, deterministicKey}
	case oldKey:
		return []string{oldKey, deterministicKey}
	case deterministicKey:
		return []string{deterministicKey, oldKey}
	default:
		return nil
	}
}

func validLegacySegment(value string) bool {
	if value == "" || len(value) > legacyAttachmentSegmentMaxBytes || strings.TrimSpace(value) != value {
		return false
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') || character == '_' || character == '-' {
			continue
		}
		return false
	}
	return true
}

// nodeSafeStorageName mirrors the Node service's /[^a-z0-9._-]/gi and
// String.prototype.slice(0, 120) behavior. The replacement is intentionally
// performed over UTF-16 code units so astral characters produce the same two
// underscores as Node rather than a Go-rune approximation.
func nodeSafeStorageName(fileName string) string {
	if !utf8.ValidString(fileName) {
		return ""
	}
	units := utf16.Encode([]rune(fileName))
	var result strings.Builder
	result.Grow(minInt(len(units), legacyStorageNameMaxBytes))
	for _, unit := range units {
		if result.Len() >= legacyStorageNameMaxBytes {
			break
		}
		if unit <= 0x7f && isNodeStorageNameByte(byte(unit)) {
			result.WriteByte(byte(unit))
			continue
		}
		result.WriteByte('_')
	}
	if result.Len() == 0 {
		return "file"
	}
	return result.String()
}

func isNodeStorageNameByte(value byte) bool {
	return (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') || (value >= '0' && value <= '9') || value == '.' || value == '_' || value == '-'
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}
