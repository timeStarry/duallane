package storage

import (
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// LegacyReader is read-only compatibility for authorized legacy records that
// predate registry size/digest metadata. Canonical objects must use BlobStore
// with their registry identity; this interface cannot bypass that check.
type LegacyReader interface {
	OpenLegacy(context.Context, string, int64) (OpenedObject, error)
}

var (
	_ LegacyReader = (*LocalBlobStore)(nil)
	_ LegacyReader = (*S3BlobStore)(nil)
	_ LegacyReader = (*HybridBlobStore)(nil)
)

func validateLegacyRead(key string, maxBytes int64) error {
	if err := validateByteSize(maxBytes, false); err != nil {
		return err
	}
	// The same portable key restrictions apply to both physical adapters.
	if isCanonicalKey(path.Clean(strings.ReplaceAll(key, "\\", "/"))) {
		return newError("storage.object_invalid_key", "存储对象路径无效", 500, errors.New("canonical object requires registry identity"))
	}
	return validateS3ObjectKey(key, "")
}

func (s *LocalBlobStore) OpenLegacy(ctx context.Context, key string, maxBytes int64) (OpenedObject, error) {
	if s == nil || s.root == "" {
		return OpenedObject{}, internalError("open legacy object", errors.New("storage root is required"))
	}
	if err := ctx.Err(); err != nil {
		return OpenedObject{}, err
	}
	if err := validateLegacyRead(key, maxBytes); err != nil {
		return OpenedObject{}, err
	}
	target, err := resolveContainedPath(s.root, key)
	if err != nil {
		return OpenedObject{}, err
	}
	if err := ensurePathParents(s.root, filepath.Dir(target)); err != nil {
		return OpenedObject{}, err
	}
	if err := ensureNoSymlink(target); err != nil {
		return OpenedObject{}, err
	}
	root, err := os.OpenRoot(s.root)
	if err != nil {
		return OpenedObject{}, internalError("open legacy root", err)
	}
	defer root.Close()
	relative, err := filepath.Rel(s.root, target)
	if err != nil {
		return OpenedObject{}, internalError("resolve legacy object", err)
	}
	// Root-relative opening also prevents a concurrent symlink replacement from
	// escaping containment between validation and open.
	body, err := root.Open(relative)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return OpenedObject{}, s3StorageMissingError()
		}
		return OpenedObject{}, internalError("open legacy object", err)
	}
	accepted := false
	defer func() {
		if !accepted {
			_ = body.Close()
		}
	}()
	info, err := body.Stat()
	if err != nil {
		return OpenedObject{}, internalError("inspect legacy object", err)
	}
	if !info.Mode().IsRegular() {
		return OpenedObject{}, s3StorageMismatchError()
	}
	if err := validateReaderLimit(maxBytes, info.Size()); err != nil {
		return OpenedObject{}, err
	}
	hash := sha256.New()
	count, err := io.Copy(hash, io.LimitReader(contextReader{ctx: ctx, r: body}, info.Size()+1))
	if err != nil {
		return OpenedObject{}, internalError("verify legacy object", err)
	}
	if count != info.Size() {
		return OpenedObject{}, s3StorageMismatchError()
	}
	if _, err := body.Seek(0, io.SeekStart); err != nil {
		return OpenedObject{}, internalError("rewind legacy object", err)
	}
	accepted = true
	return OpenedObject{
		Object: Object{Key: key, ByteSize: count, SHA256: hexDigest(hash.Sum(nil))},
		Body:   &limitedReadCloser{reader: io.LimitReader(contextReader{ctx: ctx, r: body}, count), closer: body},
	}, nil
}

func (s *S3BlobStore) OpenLegacy(ctx context.Context, key string, maxBytes int64) (OpenedObject, error) {
	if err := s.valid(); err != nil {
		return OpenedObject{}, err
	}
	if err := ctx.Err(); err != nil {
		return OpenedObject{}, err
	}
	if err := validateLegacyRead(key, maxBytes); err != nil {
		return OpenedObject{}, err
	}
	head, err := s.headObject(ctx, key)
	if err != nil {
		if isS3NotFound(err) {
			return OpenedObject{}, s3StorageMissingError()
		}
		return OpenedObject{}, s3ProviderError("inspect legacy object", err)
	}
	if head == nil || head.ContentLength == nil {
		return OpenedObject{}, s3StorageMismatchError()
	}
	if err := validateReaderLimit(maxBytes, *head.ContentLength); err != nil {
		return OpenedObject{}, err
	}
	// Open repeats size validation and bounds the stream, so a changed object
	// between HEAD and GET cannot silently evade the caller's limit.
	return s.Open(ctx, Object{Key: key, ByteSize: *head.ContentLength}, maxBytes)
}

func (s *HybridBlobStore) OpenLegacy(ctx context.Context, key string, maxBytes int64) (OpenedObject, error) {
	if err := s.valid(); err != nil {
		return OpenedObject{}, err
	}
	if err := validateLegacyRead(key, maxBytes); err != nil {
		return OpenedObject{}, err
	}
	primary, ok := s.primary.(LegacyReader)
	if !ok {
		return OpenedObject{}, internalError("open legacy object", errors.New("primary legacy reader is required"))
	}
	opened, err := primary.OpenLegacy(ctx, key, maxBytes)
	if err == nil || !s.localReadFallback || !isStorageMissing(err) {
		return opened, err
	}
	local, ok := s.local.(LegacyReader)
	if !ok {
		return OpenedObject{}, internalError("open legacy fallback", errors.New("local legacy reader is required"))
	}
	return local.OpenLegacy(ctx, key, maxBytes)
}
