package storage

import (
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	platformmetrics "github.com/timestarry/duallane/apps/backend/internal/platform/metrics"
)

// LocalBlobStore stores private Workspace bytes below one configured root.
// Files are first written with mode 0600 to a sibling temporary name and then
// atomically renamed into place. It is suitable for the current single-host
// deployment and intentionally exposes no HTTP or authorization behavior.
type LocalBlobStore struct {
	root     string
	observer *operationObserver
}

// LocalBlobStoreOptions configures a local store without changing the legacy
// root-only constructor. Observation is optional and remains on the concrete
// LocalBlobStore, preserving its LegacyReader and maintenance capabilities.
type LocalBlobStoreOptions struct {
	Root string
	ObservationOptions
}

// AssertReady inspects the configured directory without creating probe files,
// changing permissions, or mutating object/registry state.
func (s *LocalBlobStore) AssertReady(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if s == nil || s.root == "" {
		return internalError("inspect local storage", errors.New("storage root is required"))
	}
	if err := ensureNoSymlink(s.root); err != nil {
		return err
	}
	root, err := os.OpenRoot(s.root)
	if err != nil {
		return internalError("inspect local storage", err)
	}
	defer root.Close()
	_, err = root.Stat(".")
	if err != nil {
		return internalError("inspect local storage", err)
	}
	return nil
}

func NewLocalBlobStore(root string) (*LocalBlobStore, error) {
	return NewLocalBlobStoreWithOptions(LocalBlobStoreOptions{Root: root})
}

// NewLocalBlobStoreWithOptions constructs a local store with optional,
// privacy-safe operation observation.
func NewLocalBlobStoreWithOptions(options LocalBlobStoreOptions) (*LocalBlobStore, error) {
	resolved, err := cleanRoot(options.Root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(resolved, 0o700); err != nil {
		return nil, err
	}
	if err := ensureNoSymlink(resolved); err != nil {
		return nil, err
	}
	if err := os.Chmod(resolved, 0o700); err != nil {
		return nil, err
	}
	return &LocalBlobStore{root: resolved, observer: newOperationObserver(options.ObservationOptions)}, nil
}

// OpenExistingLocalBlobStore validates an existing root without provisioning or
// chmod. Passive release candidates must not mutate a live owner's filesystem
// even during dependency construction. Request admission is enforced by the
// application; this constructor alone does not make subsequent I/O read-only.
func OpenExistingLocalBlobStore(ctx context.Context, root string) (*LocalBlobStore, error) {
	return OpenExistingLocalBlobStoreWithOptions(ctx, LocalBlobStoreOptions{Root: root})
}

// OpenExistingLocalBlobStoreWithOptions validates an existing root without
// provisioning or chmod while retaining optional operation observation.
func OpenExistingLocalBlobStoreWithOptions(ctx context.Context, options LocalBlobStoreOptions) (*LocalBlobStore, error) {
	resolved, err := cleanRoot(options.Root)
	if err != nil {
		return nil, err
	}
	store := &LocalBlobStore{root: resolved, observer: newOperationObserver(options.ObservationOptions)}
	if err := store.AssertReady(ctx); err != nil {
		return nil, err
	}
	return store, nil
}

func (s *LocalBlobStore) Put(ctx context.Context, key string, source io.Reader, expectedSize int64, expectedSHA256 string) (stored StoredObject, err error) {
	observer := (*operationObserver)(nil)
	if s != nil {
		observer = s.observer
	}
	var counted *countedReader
	if observer != nil && source != nil {
		counted = &countedReader{source: source}
		source = counted
	}
	defer func() {
		var bytes int64
		if counted != nil {
			bytes = counted.bytes
		}
		outcome := platformmetrics.ObjectOutcomeFailure
		if err == nil {
			outcome = platformmetrics.ObjectOutcomeSuccess
		}
		observer.observe(platformmetrics.ObjectOperationPut, outcome, bytes)
	}()
	if s == nil || strings.TrimSpace(s.root) == "" {
		return StoredObject{}, internalError("put local object", errors.New("storage root is required"))
	}
	if err := validateByteSize(expectedSize, true); err != nil {
		return StoredObject{}, err
	}
	expectedSHA256, err = validateExpectedHash(expectedSHA256)
	if err != nil {
		return StoredObject{}, err
	}
	if isCanonicalKey(key) && expectedSHA256 == "" {
		return StoredObject{}, newError("storage.object_invalid_key", "存储对象路径无效", 500, errors.New("canonical object requires digest"))
	}
	target, err := resolveContainedPath(s.root, key)
	if err != nil {
		return StoredObject{}, err
	}
	if err := ensureNoSymlink(target); err != nil {
		return StoredObject{}, err
	}
	parent := filepath.Dir(target)
	if err := ensurePathParents(s.root, parent); err != nil {
		return StoredObject{}, err
	}
	if info, statErr := os.Stat(target); statErr == nil {
		if !info.Mode().IsRegular() {
			return StoredObject{}, newError("storage.object_conflict", "存储对象登记冲突", 409, errors.New("target is not a regular file"))
		}
		if expectedSHA256 != "" {
			stored, validateErr := validateFile(ctx, target, expectedSize, expectedSHA256)
			if validateErr != nil {
				return StoredObject{}, newError("storage.object_conflict", "存储对象登记冲突", 409, validateErr)
			}
			stored.Key = key
			stored.ContentType = ""
			stored.Reused = true
			return stored, nil
		}
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return StoredObject{}, internalError("inspect local object", statErr)
	}

	if err := os.MkdirAll(parent, 0o700); err != nil {
		return StoredObject{}, internalError("create local object directory", err)
	}
	// Recheck after creating missing parents so a concurrently inserted symlink
	// cannot redirect the temporary file outside the configured root.
	if err := ensurePathParents(s.root, parent); err != nil {
		return StoredObject{}, err
	}
	temporary, err := os.CreateTemp(parent, ".duallane-object-*.tmp")
	if err != nil {
		return StoredObject{}, internalError("stage local object", err)
	}
	temporaryPath := temporary.Name()
	defer func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return StoredObject{}, internalError("secure local object staging", err)
	}
	written, digest, err := copyAndHash(ctx, temporary, source, expectedSize)
	if err != nil {
		return StoredObject{}, err
	}
	if expectedSHA256 != "" && digest != expectedSHA256 {
		return StoredObject{}, newError("upload.hash_mismatch", "上传内容校验失败", 400, errDigestMismatch)
	}
	if err := temporary.Sync(); err != nil {
		return StoredObject{}, internalError("flush local object", err)
	}
	if err := temporary.Close(); err != nil {
		return StoredObject{}, internalError("close local object", err)
	}
	if err := os.Rename(temporaryPath, target); err != nil {
		if errors.Is(err, os.ErrExist) {
			stored, validateErr := validateFile(ctx, target, expectedSize, expectedSHA256OrDigest(expectedSHA256, digest))
			if validateErr != nil {
				return StoredObject{}, newError("storage.object_conflict", "存储对象登记冲突", 409, validateErr)
			}
			stored.Key = key
			stored.Reused = true
			return stored, nil
		}
		return StoredObject{}, internalError("commit local object", err)
	}
	return StoredObject{Object: Object{Key: key, SHA256: digest, ByteSize: written}, Reused: false}, nil
}

func (s *LocalBlobStore) Open(ctx context.Context, object Object, maxBytes int64) (opened OpenedObject, err error) {
	observer := (*operationObserver)(nil)
	if s != nil {
		observer = s.observer
	}
	defer func() {
		opened, err = observer.observeOpened(ctx, opened, err)
	}()
	if s == nil || strings.TrimSpace(s.root) == "" {
		return OpenedObject{}, internalError("open local object", errors.New("storage root is required"))
	}
	if err := validateByteSize(object.ByteSize, true); err != nil {
		return OpenedObject{}, err
	}
	if err := validateReaderLimit(maxBytes, object.ByteSize); err != nil {
		return OpenedObject{}, err
	}
	digest, err := validateExpectedHash(object.SHA256)
	if err != nil {
		return OpenedObject{}, err
	}
	if isCanonicalKey(object.Key) {
		if digest == "" {
			return OpenedObject{}, newError("storage.object_invalid_key", "存储对象路径无效", 500, errors.New("canonical object requires digest"))
		}
		if err := ValidateCanonicalKey(object.Key, digest); err != nil {
			return OpenedObject{}, err
		}
	}
	target, err := resolveContainedPath(s.root, object.Key)
	if err != nil {
		return OpenedObject{}, err
	}
	if err := ensurePathParents(s.root, filepath.Dir(target)); err != nil {
		return OpenedObject{}, err
	}
	if err := ensureNoSymlink(target); err != nil {
		return OpenedObject{}, err
	}
	stored, err := validateFile(ctx, target, object.ByteSize, digest)
	if err != nil {
		return OpenedObject{}, err
	}
	body, err := os.Open(target)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return OpenedObject{}, newError("file.storage_missing", "文件内容不可用", 404, err)
		}
		return OpenedObject{}, internalError("open local object", err)
	}
	return OpenedObject{Object: Object{Key: object.Key, SHA256: stored.SHA256, ByteSize: stored.ByteSize, ContentType: object.ContentType}, Body: &limitedReadCloser{reader: io.LimitReader(body, object.ByteSize), closer: body}}, nil
}

func (s *LocalBlobStore) Delete(_ context.Context, object Object) (err error) {
	observer := (*operationObserver)(nil)
	if s != nil {
		observer = s.observer
	}
	defer func() {
		outcome := platformmetrics.ObjectOutcomeFailure
		if err == nil {
			outcome = platformmetrics.ObjectOutcomeSuccess
		}
		observer.observe(platformmetrics.ObjectOperationDelete, outcome, object.ByteSize)
	}()
	if s == nil || strings.TrimSpace(s.root) == "" {
		return internalError("delete local object", errors.New("storage root is required"))
	}
	if isCanonicalKey(object.Key) {
		if object.SHA256 == "" {
			return newError("storage.object_invalid_key", "存储对象路径无效", 500, errors.New("canonical object requires digest"))
		}
		if err := ValidateCanonicalKey(object.Key, object.SHA256); err != nil {
			return err
		}
	}
	target, err := resolveContainedPath(s.root, object.Key)
	if err != nil {
		return err
	}
	if err := ensurePathParents(s.root, filepath.Dir(target)); err != nil {
		return err
	}
	if err := ensureNoSymlink(target); err != nil {
		return err
	}
	if info, err := os.Stat(target); err == nil && !info.Mode().IsRegular() {
		return newError("storage.object_conflict", "存储对象登记冲突", 409, errors.New("target is not a regular file"))
	}
	if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
		return internalError("delete local object", err)
	}
	return nil
}

// ListUploadAttemptObjects enumerates only the flat attempts directory for
// one validated upload. It intentionally rejects symlinks instead of
// resolving them so a cleanup worker cannot escape the configured root.
func (s *LocalBlobStore) ListUploadAttemptObjects(ctx context.Context, uploadID string, before time.Time, cursor string, limit int) (page UploadAttemptObjectPage, err error) {
	observer := (*operationObserver)(nil)
	if s != nil {
		observer = s.observer
	}
	defer func() {
		outcome := platformmetrics.ObjectOutcomeFailure
		if err == nil {
			outcome = platformmetrics.ObjectOutcomeSuccess
		}
		observer.observe(platformmetrics.ObjectOperationCleanup, outcome, 0)
	}()
	if err := ctx.Err(); err != nil {
		return UploadAttemptObjectPage{}, err
	}
	if s == nil || strings.TrimSpace(s.root) == "" {
		return UploadAttemptObjectPage{}, internalError("list local upload attempts", errors.New("storage root is required"))
	}
	prefix, err := uploadAttemptPrefix(uploadID)
	if err != nil {
		return UploadAttemptObjectPage{}, err
	}
	root, err := os.OpenRoot(s.root)
	if err != nil {
		return UploadAttemptObjectPage{}, internalError("open local upload maintenance root", err)
	}
	defer root.Close()
	relativeDirectory := filepath.FromSlash(strings.TrimSuffix(prefix, "/"))
	if err := ensurePathParents(s.root, filepath.Join(s.root, relativeDirectory)); err != nil {
		return UploadAttemptObjectPage{}, err
	}
	directoryInfo, err := root.Lstat(relativeDirectory)
	if errors.Is(err, os.ErrNotExist) {
		return UploadAttemptObjectPage{}, nil
	}
	if err != nil {
		return UploadAttemptObjectPage{}, internalError("inspect local upload attempts", err)
	}
	if directoryInfo.Mode()&os.ModeSymlink != 0 {
		return UploadAttemptObjectPage{}, newError("storage.invalid_key", "文件存储路径无效", 500, errors.New("upload attempts directory is a symlink"))
	}
	if !directoryInfo.IsDir() {
		return UploadAttemptObjectPage{}, newError("storage.object_conflict", "存储对象登记冲突", 409, errors.New("upload attempts path is not a directory"))
	}
	directory, err := root.Open(relativeDirectory)
	if errors.Is(err, os.ErrNotExist) {
		return UploadAttemptObjectPage{}, nil
	}
	if err != nil {
		return UploadAttemptObjectPage{}, internalError("open local upload attempts", err)
	}
	defer directory.Close()
	page = UploadAttemptObjectPage{Objects: make([]UploadAttemptObject, 0, minMaintenancePageCapacity(limit))}
	limit = normalizeMaintenanceLimit(limit)
	// File.ReadDir returns filesystem order, not lexical order. Scan bounded
	// chunks and retain only the smallest page after the key cursor; otherwise
	// an early high key can permanently skip lower keys on the next call.
	for {
		if err := ctx.Err(); err != nil {
			return UploadAttemptObjectPage{}, err
		}
		entries, readErr := directory.ReadDir(128)
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return UploadAttemptObjectPage{}, internalError("list local upload attempts", readErr)
		}
		for _, entry := range entries {
			if err := ctx.Err(); err != nil {
				return UploadAttemptObjectPage{}, err
			}
			if entry.Type()&os.ModeSymlink != 0 {
				return UploadAttemptObjectPage{}, newError("storage.invalid_key", "文件存储路径无效", 500, errors.New("symlink is not allowed in upload attempts"))
			}
			if !entry.Type().IsRegular() {
				continue
			}
			key := prefix + entry.Name()
			if _, err := validateUploadAttemptObjectKey(uploadID, key); err != nil {
				return UploadAttemptObjectPage{}, err
			}
			if key <= cursor {
				continue
			}
			info, err := root.Lstat(filepath.Join(relativeDirectory, entry.Name()))
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return UploadAttemptObjectPage{}, internalError("stat local upload attempt", err)
			}
			if !info.Mode().IsRegular() {
				continue
			}
			if !before.IsZero() && info.ModTime().After(before) {
				continue
			}
			index := sort.Search(len(page.Objects), func(index int) bool { return page.Objects[index].Key >= key })
			if index >= limit {
				continue
			}
			if len(page.Objects) < limit {
				page.Objects = append(page.Objects, UploadAttemptObject{})
			}
			copy(page.Objects[index+1:], page.Objects[index:len(page.Objects)-1])
			page.Objects[index] = UploadAttemptObject{Key: key, LastModified: info.ModTime().UTC(), ByteSize: info.Size()}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
	}
	if len(page.Objects) == limit {
		page.NextCursor = page.Objects[len(page.Objects)-1].Key
	}
	return page, nil
}

// DeleteUploadAttemptObject removes one object after validating that the key
// is a single child of the requested upload's attempts directory.
func (s *LocalBlobStore) DeleteUploadAttemptObject(ctx context.Context, uploadID, key string) (err error) {
	observer := (*operationObserver)(nil)
	if s != nil {
		observer = s.observer
	}
	var bytes int64
	defer func() {
		outcome := platformmetrics.ObjectOutcomeFailure
		if err == nil {
			outcome = platformmetrics.ObjectOutcomeSuccess
		}
		observer.observe(platformmetrics.ObjectOperationCleanup, outcome, bytes)
	}()
	if err := ctx.Err(); err != nil {
		return err
	}
	if s == nil || strings.TrimSpace(s.root) == "" {
		return internalError("delete local upload attempt", errors.New("storage root is required"))
	}
	key, err = validateUploadAttemptObjectKey(uploadID, key)
	if err != nil {
		return err
	}
	if err := ensurePathParents(s.root, filepath.Dir(filepath.Join(s.root, filepath.FromSlash(key)))); err != nil {
		return err
	}
	root, err := os.OpenRoot(s.root)
	if err != nil {
		return internalError("open local upload maintenance root", err)
	}
	defer root.Close()
	relativeKey := filepath.FromSlash(key)
	info, err := root.Lstat(relativeKey)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return internalError("inspect local upload attempt", err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return newError("storage.invalid_key", "文件存储路径无效", 500, errors.New("attempt is a symlink"))
	}
	if !info.Mode().IsRegular() {
		return newError("storage.object_conflict", "存储对象登记冲突", 409, errors.New("attempt is not a regular file"))
	}
	bytes = info.Size()
	if err := root.Remove(relativeKey); err != nil && !errors.Is(err, os.ErrNotExist) {
		return internalError("delete local upload attempt", err)
	}
	return nil
}

func minMaintenancePageCapacity(limit int) int {
	if limit <= 0 || limit > 1000 {
		return DefaultMaintenanceBatchSize
	}
	return limit
}

var errDigestMismatch = errors.New("object digest mismatch")

type limitedReadCloser struct {
	reader io.Reader
	closer io.Closer
}

func (r *limitedReadCloser) Read(p []byte) (int, error) {
	return r.reader.Read(p)
}

func (r *limitedReadCloser) Close() error {
	return r.closer.Close()
}

func expectedSHA256OrDigest(expected, actual string) string {
	if expected != "" {
		return expected
	}
	return actual
}

func validateFile(ctx context.Context, path string, expectedSize int64, expectedSHA256 string) (StoredObject, error) {
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return StoredObject{}, newError("file.storage_missing", "文件内容不可用", 404, err)
		}
		return StoredObject{}, internalError("stat local object", err)
	}
	if !info.Mode().IsRegular() {
		return StoredObject{}, newError("file.storage_mismatch", "文件内容不可用", 500, errors.New("object is not regular"))
	}
	if info.Size() != expectedSize {
		return StoredObject{}, newError("file.storage_mismatch", "文件内容不可用", 500, errors.New("object size mismatch"))
	}
	file, err := os.Open(path)
	if err != nil {
		return StoredObject{}, internalError("read local object", err)
	}
	defer file.Close()
	hash := sha256.New()
	_, err = io.Copy(hash, contextReader{ctx: ctx, r: io.LimitReader(file, expectedSize+1)})
	if err != nil {
		return StoredObject{}, internalError("hash local object", err)
	}
	digest := hexDigest(hash.Sum(nil))
	if expectedSHA256 != "" && digest != expectedSHA256 {
		return StoredObject{}, newError("file.storage_mismatch", "文件内容不可用", 500, errDigestMismatch)
	}
	return StoredObject{Object: Object{SHA256: digest, ByteSize: info.Size()}}, nil
}

func hexDigest(value []byte) string {
	const hexDigits = "0123456789abcdef"
	result := make([]byte, len(value)*2)
	for index, value := range value {
		result[index*2] = hexDigits[value>>4]
		result[index*2+1] = hexDigits[value&0x0f]
	}
	return string(result)
}

func ensurePathParents(root, parent string) error {
	current := parent
	for {
		if err := ensureNoSymlink(current); err != nil {
			return err
		}
		if current == root {
			return nil
		}
		next := filepath.Dir(current)
		if next == current {
			return newError("storage.invalid_key", "文件存储路径无效", 500, errors.New("path root mismatch"))
		}
		current = next
	}
}
