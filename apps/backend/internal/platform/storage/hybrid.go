package storage

import (
	"context"
	"errors"
	"io"
)

// HybridBlobStoreOptions selects the primary store and the optional retained
// local copy used during the S3 migration window. Local storage is required
// only when either compatibility flag is enabled.
type HybridBlobStoreOptions struct {
	Primary           BlobStore
	Local             BlobStore
	LocalReadFallback bool
	LocalMirrorWrite  bool
}

// HybridBlobStore keeps S3 as the source of truth while preserving the Node
// migration behavior for a local mirror and missing-object fallback. Provider
// details stay behind the two BlobStore interfaces.
type HybridBlobStore struct {
	primary           BlobStore
	local             BlobStore
	localReadFallback bool
	localMirrorWrite  bool
}

var _ BlobStore = (*HybridBlobStore)(nil)

// NewHybridBlobStore builds a primary-plus-local compatibility store. The
// primary is always required; a local store is required only for an enabled
// fallback or mirror operation.
func NewHybridBlobStore(options HybridBlobStoreOptions) (*HybridBlobStore, error) {
	if options.Primary == nil {
		return nil, internalError("create hybrid object store", errors.New("primary blob store is required"))
	}
	if (options.LocalReadFallback || options.LocalMirrorWrite) && options.Local == nil {
		return nil, internalError("create hybrid object store", errors.New("local blob store is required"))
	}
	return &HybridBlobStore{
		primary:           options.Primary,
		local:             options.Local,
		localReadFallback: options.LocalReadFallback,
		localMirrorWrite:  options.LocalMirrorWrite,
	}, nil
}

func (s *HybridBlobStore) valid() error {
	if s == nil || s.primary == nil {
		return internalError("workspace hybrid storage", errors.New("primary blob store is required"))
	}
	if s.localEnabled() && s.local == nil {
		return internalError("workspace hybrid storage", errors.New("local blob store is required"))
	}
	return nil
}

func (s *HybridBlobStore) localEnabled() bool {
	return s != nil && (s.localReadFallback || s.localMirrorWrite)
}

func (s *HybridBlobStore) AssertReady(ctx context.Context) error {
	if err := s.valid(); err != nil {
		return err
	}
	if ready, ok := s.primary.(interface{ AssertReady(context.Context) error }); ok {
		return ready.AssertReady(ctx)
	}
	return nil
}

// Put writes to the primary first. A configured local mirror is populated only
// after the primary succeeds; because BlobStore consumes its input stream, the
// successful primary object is reopened as a bounded stream for mirroring.
func (s *HybridBlobStore) Put(ctx context.Context, key string, source io.Reader, expectedSize int64, expectedSHA256 string) (StoredObject, error) {
	if err := s.valid(); err != nil {
		return StoredObject{}, err
	}
	stored, err := s.primary.Put(ctx, key, source, expectedSize, expectedSHA256)
	if err != nil || !s.localMirrorWrite {
		return stored, err
	}

	object := stored.Object
	if object.Key == "" {
		object.Key = key
	}
	opened, err := s.primary.Open(ctx, object, object.ByteSize)
	if err != nil {
		return StoredObject{}, err
	}
	if opened.Body == nil {
		return StoredObject{}, internalError("mirror workspace object", errors.New("primary object body is required"))
	}
	_, mirrorErr := s.local.Put(ctx, object.Key, opened.Body, object.ByteSize, object.SHA256)
	closeErr := opened.Body.Close()
	if mirrorErr != nil {
		return StoredObject{}, mergeStorageErrors(mirrorErr, closeErr)
	}
	if closeErr != nil {
		return StoredObject{}, internalError("close primary mirror source", closeErr)
	}
	return stored, nil
}

// Open consults Local only for the precise missing-object result. Provider
// outages, size mismatches, invalid keys, and other primary errors must remain
// visible to callers instead of being masked by a stale local copy.
func (s *HybridBlobStore) Open(ctx context.Context, object Object, maxBytes int64) (OpenedObject, error) {
	if err := s.valid(); err != nil {
		return OpenedObject{}, err
	}
	opened, err := s.primary.Open(ctx, object, maxBytes)
	if err == nil || !s.localReadFallback || !isStorageMissing(err) {
		return opened, err
	}
	return s.local.Open(ctx, object, maxBytes)
}

// Delete always attempts the primary and every enabled local endpoint. The
// first safe domain error is retained while the other failure is attached as a
// private cause, so public serialization cannot expose provider details.
func (s *HybridBlobStore) Delete(ctx context.Context, object Object) error {
	if err := s.valid(); err != nil {
		return err
	}
	primaryErr := s.primary.Delete(ctx, object)
	if !s.localEnabled() {
		return primaryErr
	}
	localErr := s.local.Delete(ctx, object)
	return mergeStorageErrors(primaryErr, localErr)
}

func isStorageMissing(err error) bool {
	var storageErr *Error
	return errors.As(err, &storageErr) && storageErr.Code == "file.storage_missing"
}

func mergeStorageErrors(first, second error) error {
	if first == nil {
		return second
	}
	if second == nil {
		return first
	}
	var storageErr *Error
	if errors.As(first, &storageErr) {
		copy := *storageErr
		copy.Cause = errors.Join(storageErr.Cause, second)
		return &copy
	}
	return internalError("combine workspace storage errors", errors.Join(first, second))
}
