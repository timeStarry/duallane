package storageops

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

// ReadOnlyStoreKind identifies the physical read endpoint used by verify.
// There is intentionally no hybrid or provider-provisioning mode here: a
// verification run must have one explicit source of truth.
type ReadOnlyStoreKind string

const (
	ReadOnlyLocalStore ReadOnlyStoreKind = "local"
	ReadOnlyS3Store    ReadOnlyStoreKind = "s3"
)

// ReadOnlyStoreOptions contains non-secret local or S3 connection settings.
// S3 credentials are supplied by the command after reading the existing
// private credentials-file contract; this package never logs or serializes
// them.
type ReadOnlyStoreOptions struct {
	Kind       ReadOnlyStoreKind
	ObjectRoot string
	S3         storage.S3Config
}

// ReadOnlyStore wraps a BlobStore and makes the no-write guarantee part of the
// type. Verify can therefore not accidentally call Put or Delete even if a
// future provider adapter exposes those methods.
type ReadOnlyStore struct {
	inner  storage.BlobStore
	closer io.Closer
}

var _ storage.BlobStore = (*ReadOnlyStore)(nil)

// OpenReadOnlyStore opens an existing local root or performs a read-only S3
// bucket readiness check. It never creates directories, changes permissions,
// uploads, deletes, aborts multipart work, or mutates provider configuration.
func OpenReadOnlyStore(ctx context.Context, options ReadOnlyStoreOptions) (*ReadOnlyStore, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	switch ReadOnlyStoreKind(strings.ToLower(strings.TrimSpace(string(options.Kind)))) {
	case ReadOnlyLocalStore:
		local, err := newLocalReadOnlyStore(options.ObjectRoot)
		if err != nil {
			return nil, err
		}
		return &ReadOnlyStore{inner: local, closer: local}, nil
	case ReadOnlyS3Store:
		remote, err := storage.NewS3BlobStore(options.S3)
		if err != nil {
			return nil, fmtStorageFactoryError(err)
		}
		if err := remote.AssertReady(ctx); err != nil {
			return nil, fmtStorageFactoryError(err)
		}
		return &ReadOnlyStore{inner: remote}, nil
	default:
		return nil, fmtStorageFactoryError(errors.New("read-only store kind is invalid"))
	}
}

func (s *ReadOnlyStore) Open(ctx context.Context, object storage.Object, maxBytes int64) (storage.OpenedObject, error) {
	if s == nil || s.inner == nil {
		return storage.OpenedObject{}, fmtStorageFactoryError(errors.New("read-only store is unavailable"))
	}
	return s.inner.Open(ctx, object, maxBytes)
}

func (s *ReadOnlyStore) Put(context.Context, string, io.Reader, int64, string) (storage.StoredObject, error) {
	return storage.StoredObject{}, ErrReadOnlyTarget
}

func (s *ReadOnlyStore) Delete(context.Context, storage.Object) error {
	return ErrReadOnlyTarget
}

// AssertReady is useful to callers that want the same explicit readiness
// probe after construction without gaining a mutating interface.
func (s *ReadOnlyStore) AssertReady(ctx context.Context) error {
	if s == nil || s.inner == nil {
		return fmtStorageFactoryError(errors.New("read-only store is unavailable"))
	}
	if ready, ok := s.inner.(interface{ AssertReady(context.Context) error }); ok {
		return ready.AssertReady(ctx)
	}
	return nil
}

func (s *ReadOnlyStore) Close() error {
	if s == nil || s.closer == nil {
		return nil
	}
	return s.closer.Close()
}

type localReadOnlyStore struct {
	root *os.Root
}

var _ storage.BlobStore = (*localReadOnlyStore)(nil)

func newLocalReadOnlyStore(rootPath string) (*localReadOnlyStore, error) {
	rootPath = strings.TrimSpace(rootPath)
	if rootPath == "" {
		return nil, fmtStorageFactoryError(errors.New("local object root is required"))
	}
	absolute, err := filepath.Abs(rootPath)
	if err != nil {
		return nil, fmtStorageFactoryError(errors.New("local object root is invalid"))
	}
	absolute = filepath.Clean(absolute)
	info, err := os.Lstat(absolute)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return nil, fmtStorageFactoryError(errors.New("local object root is unavailable"))
	}
	root, err := os.OpenRoot(absolute)
	if err != nil {
		return nil, fmtStorageFactoryError(errors.New("local object root is unavailable"))
	}
	return &localReadOnlyStore{root: root}, nil
}

func (s *localReadOnlyStore) Open(ctx context.Context, object storage.Object, maxBytes int64) (storage.OpenedObject, error) {
	if err := contextErr(ctx); err != nil {
		return storage.OpenedObject{}, err
	}
	if s == nil || s.root == nil {
		return storage.OpenedObject{}, fmtStorageFactoryError(errors.New("local object root is unavailable"))
	}
	digest, err := storage.NormalizeSHA256(object.SHA256)
	if err != nil {
		return storage.OpenedObject{}, fmtStorageFactoryError(errors.New("canonical object digest is invalid"))
	}
	if err := storage.ValidateCanonicalKey(object.Key, digest); err != nil {
		return storage.OpenedObject{}, fmtStorageFactoryError(errors.New("canonical object key is invalid"))
	}
	if maxBytes <= 0 {
		maxBytes = storage.DefaultMaxObjectBytes
	}
	if object.ByteSize < 0 || object.ByteSize > maxBytes || object.ByteSize > storage.DefaultMaxObjectBytes {
		return storage.OpenedObject{}, fmtStorageFactoryError(errors.New("canonical object size is invalid"))
	}
	relative := filepath.FromSlash(object.Key)
	if err := rejectLocalSymlinks(s.root, relative); err != nil {
		return storage.OpenedObject{}, err
	}
	info, err := s.root.Lstat(relative)
	if err != nil {
		return storage.OpenedObject{}, fmtStorageFactoryError(errors.New("canonical object is unavailable"))
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return storage.OpenedObject{}, fmtStorageFactoryError(errors.New("canonical object is not a regular file"))
	}
	if info.Size() != object.ByteSize {
		return storage.OpenedObject{}, fmtStorageFactoryError(errors.New("canonical object size mismatch"))
	}
	file, err := s.root.Open(relative)
	if err != nil {
		return storage.OpenedObject{}, fmtStorageFactoryError(errors.New("canonical object is unavailable"))
	}
	count, actualDigest, hashErr := hashLocalFile(ctx, file, object.ByteSize)
	if hashErr != nil || count != object.ByteSize || actualDigest != digest {
		_ = file.Close()
		return storage.OpenedObject{}, fmtStorageFactoryError(errors.New("canonical object digest mismatch"))
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		_ = file.Close()
		return storage.OpenedObject{}, fmtStorageFactoryError(errors.New("canonical object cannot be rewound"))
	}
	return storage.OpenedObject{
		Object: storage.Object{
			Key: object.Key, SHA256: digest, ByteSize: object.ByteSize, ContentType: object.ContentType,
		},
		Body: &localReadOnlyBody{reader: io.LimitReader(file, object.ByteSize), closer: file},
	}, nil
}

func (s *localReadOnlyStore) Put(context.Context, string, io.Reader, int64, string) (storage.StoredObject, error) {
	return storage.StoredObject{}, ErrReadOnlyTarget
}

func (s *localReadOnlyStore) Delete(context.Context, storage.Object) error {
	return ErrReadOnlyTarget
}

func (s *localReadOnlyStore) Close() error {
	if s == nil || s.root == nil {
		return nil
	}
	return s.root.Close()
}

func rejectLocalSymlinks(root *os.Root, relative string) error {
	clean := filepath.Clean(relative)
	if clean == "." || filepath.IsAbs(clean) || strings.ContainsRune(relative, '\x00') {
		return fmtStorageFactoryError(errors.New("canonical object path is invalid"))
	}
	parts := strings.Split(clean, string(filepath.Separator))
	current := ""
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return fmtStorageFactoryError(errors.New("canonical object path is invalid"))
		}
		if current == "" {
			current = part
		} else {
			current = filepath.Join(current, part)
		}
		info, err := root.Lstat(current)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) && current == clean {
				return nil
			}
			return fmtStorageFactoryError(errors.New("canonical object path is unavailable"))
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmtStorageFactoryError(errors.New("canonical object path contains a symlink"))
		}
	}
	return nil
}

func hashLocalFile(ctx context.Context, file *os.File, expectedSize int64) (int64, string, error) {
	if file == nil {
		return 0, "", errors.New("local object file is unavailable")
	}
	hash := sha256.New()
	count, err := io.Copy(hash, io.LimitReader(contextReader{ctx: ctx, reader: file}, expectedSize+1))
	if err != nil {
		return count, "", err
	}
	return count, hex.EncodeToString(hash.Sum(nil)), nil
}

type localReadOnlyBody struct {
	reader io.Reader
	closer io.Closer
}

func (b *localReadOnlyBody) Read(buffer []byte) (int, error) {
	return b.reader.Read(buffer)
}

func (b *localReadOnlyBody) Close() error {
	return b.closer.Close()
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(buffer []byte) (int, error) {
	if err := contextErr(r.ctx); err != nil {
		return 0, err
	}
	return r.reader.Read(buffer)
}

func contextErr(ctx context.Context) error {
	if ctx == nil {
		return nil
	}
	return ctx.Err()
}

func fmtStorageFactoryError(_ error) error {
	return errors.New("storageops.read_only_store_unavailable")
}
