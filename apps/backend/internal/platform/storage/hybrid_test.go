package storage

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
)

type hybridFakeObject struct {
	object  Object
	content []byte
}

type hybridFakeBlobStore struct {
	mu sync.Mutex

	objects map[string]hybridFakeObject
	events  []string

	putErr      error
	openErr     error
	deleteErr   error
	putCalls    int
	openCalls   int
	deleteCalls int
}

func newHybridFakeBlobStore() *hybridFakeBlobStore {
	return &hybridFakeBlobStore{objects: make(map[string]hybridFakeObject)}
}

func (s *hybridFakeBlobStore) Put(_ context.Context, key string, source io.Reader, expectedSize int64, expectedSHA256 string) (StoredObject, error) {
	s.mu.Lock()
	s.putCalls++
	s.events = append(s.events, "put")
	putErr := s.putErr
	s.mu.Unlock()
	if putErr != nil {
		return StoredObject{}, putErr
	}
	content, err := io.ReadAll(source)
	if err != nil {
		return StoredObject{}, err
	}
	if int64(len(content)) != expectedSize {
		return StoredObject{}, newError("upload.size_mismatch", "上传内容大小与预留不一致", 400, errors.New("fake size mismatch"))
	}
	digest := digestForBytes(content)
	if expectedSHA256 != "" && !strings.EqualFold(expectedSHA256, digest) {
		return StoredObject{}, newError("upload.hash_mismatch", "上传内容校验失败", 400, errDigestMismatch)
	}
	object := Object{Key: key, SHA256: digest, ByteSize: expectedSize}
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.objects[key]; ok && (expectedSHA256 == "" || existing.object.SHA256 == digest) {
		return StoredObject{Object: existing.object, Reused: true}, nil
	}
	s.objects[key] = hybridFakeObject{object: object, content: append([]byte(nil), content...)}
	return StoredObject{Object: object}, nil
}

func (s *hybridFakeBlobStore) Open(_ context.Context, object Object, maxBytes int64) (OpenedObject, error) {
	s.mu.Lock()
	s.openCalls++
	s.events = append(s.events, "open")
	openErr := s.openErr
	value, ok := s.objects[object.Key]
	s.mu.Unlock()
	if openErr != nil {
		return OpenedObject{}, openErr
	}
	if !ok {
		return OpenedObject{}, s3StorageMissingError()
	}
	if maxBytes > 0 && int64(len(value.content)) > maxBytes {
		return OpenedObject{}, newError("file.storage_too_large", "文件内容过大", 413, errors.New("fake read limit"))
	}
	return OpenedObject{
		Object: value.object,
		Body:   io.NopCloser(bytes.NewReader(value.content)),
	}, nil
}

func (s *hybridFakeBlobStore) Delete(_ context.Context, object Object) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deleteCalls++
	s.events = append(s.events, "delete")
	if s.deleteErr != nil {
		return s.deleteErr
	}
	delete(s.objects, object.Key)
	return nil
}

func (s *hybridFakeBlobStore) eventSnapshot() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.events...)
}

func TestHybridBlobStoreMirrorsOnlyAfterPrimarySuccess(t *testing.T) {
	primary := newHybridFakeBlobStore()
	local := newHybridFakeBlobStore()
	store, err := NewHybridBlobStore(HybridBlobStoreOptions{
		Primary:          primary,
		Local:            local,
		LocalMirrorWrite: true,
	})
	if err != nil {
		t.Fatalf("new hybrid store: %v", err)
	}

	content := []byte("mirrored bytes")
	key := "workspace/uploads/upload-1/content"
	stored, err := store.Put(context.Background(), key, bytes.NewReader(content), int64(len(content)), "")
	if err != nil {
		t.Fatalf("put mirrored object: %v", err)
	}
	if stored.Key != key || stored.ByteSize != int64(len(content)) {
		t.Fatalf("unexpected stored object: %#v", stored)
	}
	if got := primary.eventSnapshot(); !equalStrings(got, []string{"put", "open"}) {
		t.Fatalf("primary events = %#v", got)
	}
	if got := local.eventSnapshot(); !equalStrings(got, []string{"put"}) {
		t.Fatalf("local events = %#v", got)
	}
	localObject, ok := local.objects[key]
	if !ok || !bytes.Equal(localObject.content, content) {
		t.Fatalf("local mirror = %#v", localObject)
	}

	primary.putErr = newError("file.storage_unavailable", "文件存储暂时不可用", 503, errors.New("primary write failed"))
	if _, err := store.Put(context.Background(), "workspace/uploads/upload-1/failed", bytes.NewReader(content), int64(len(content)), ""); errorCode(t, err) != "file.storage_unavailable" {
		t.Fatalf("primary failure code = %q", errorCode(t, err))
	}
	if local.putCalls != 1 {
		t.Fatalf("local was called after primary failure: %d", local.putCalls)
	}
}

func TestHybridBlobStoreFallsBackOnlyForMissingPrimaryObjects(t *testing.T) {
	primary := newHybridFakeBlobStore()
	local := newHybridFakeBlobStore()
	content := []byte("local fallback")
	key := "workspace/uploads/upload-2/content"
	local.objects[key] = hybridFakeObject{
		object:  Object{Key: key, SHA256: digestForBytes(content), ByteSize: int64(len(content))},
		content: content,
	}
	store, err := NewHybridBlobStore(HybridBlobStoreOptions{
		Primary:           primary,
		Local:             local,
		LocalReadFallback: true,
	})
	if err != nil {
		t.Fatalf("new hybrid store: %v", err)
	}
	primary.openErr = s3StorageMissingError()
	opened, err := store.Open(context.Background(), Object{Key: key, ByteSize: int64(len(content))}, int64(len(content)))
	if err != nil {
		t.Fatalf("fallback open: %v", err)
	}
	got, readErr := io.ReadAll(opened.Body)
	_ = opened.Body.Close()
	if readErr != nil || !bytes.Equal(got, content) {
		t.Fatalf("fallback content = %q, err = %v", got, readErr)
	}
	if local.openCalls != 1 {
		t.Fatalf("local fallback calls = %d", local.openCalls)
	}

	primary.openErr = newError("file.storage_unavailable", "文件存储暂时不可用", 503, errors.New("provider unavailable"))
	if _, err := store.Open(context.Background(), Object{Key: key, ByteSize: int64(len(content))}, int64(len(content))); errorCode(t, err) != "file.storage_unavailable" {
		t.Fatalf("provider error code = %q", errorCode(t, err))
	}
	if local.openCalls != 1 {
		t.Fatalf("local masked provider error with %d calls", local.openCalls)
	}

	primary.openErr = s3StorageMismatchError()
	if _, err := store.Open(context.Background(), Object{Key: key, ByteSize: int64(len(content))}, int64(len(content))); errorCode(t, err) != "file.storage_mismatch" {
		t.Fatalf("mismatch error code = %q", errorCode(t, err))
	}
	if local.openCalls != 1 {
		t.Fatalf("local masked mismatch with %d calls", local.openCalls)
	}
}

func TestHybridBlobStoreDeletesBothEnabledStoresAndSafelyAggregates(t *testing.T) {
	primary := newHybridFakeBlobStore()
	local := newHybridFakeBlobStore()
	primaryCause := errors.New("primary provider detail")
	localCause := errors.New("local provider detail")
	primary.deleteErr = newError("file.storage_unavailable", "文件存储暂时不可用", 503, primaryCause)
	local.deleteErr = newError("internal.error", "服务暂时不可用", 500, localCause)
	store, err := NewHybridBlobStore(HybridBlobStoreOptions{
		Primary:           primary,
		Local:             local,
		LocalReadFallback: true,
	})
	if err != nil {
		t.Fatalf("new hybrid store: %v", err)
	}
	err = store.Delete(context.Background(), Object{Key: "workspace/uploads/upload-3/content"})
	if errorCode(t, err) != "file.storage_unavailable" {
		t.Fatalf("aggregated error code = %q", errorCode(t, err))
	}
	if !errors.Is(err, primaryCause) || !errors.Is(err, localCause) {
		t.Fatalf("aggregated causes missing: %v", err)
	}
	if primary.deleteCalls != 1 || local.deleteCalls != 1 {
		t.Fatalf("delete calls = primary:%d local:%d", primary.deleteCalls, local.deleteCalls)
	}
	if strings.Contains(err.Error(), "provider detail") {
		t.Fatalf("aggregated public error leaked provider details: %q", err.Error())
	}
	var safeErr *Error
	if !errors.As(err, &safeErr) || safeErr.Public().Cause != nil {
		t.Fatalf("aggregated public error is not safe: %#v", safeErr.Public())
	}
}

func TestNewHybridBlobStoreRequiresEnabledEndpoints(t *testing.T) {
	primary := newHybridFakeBlobStore()
	if _, err := NewHybridBlobStore(HybridBlobStoreOptions{}); errorCode(t, err) != "internal.error" {
		t.Fatalf("missing primary code = %q", errorCode(t, err))
	}
	if _, err := NewHybridBlobStore(HybridBlobStoreOptions{Primary: primary, LocalReadFallback: true}); errorCode(t, err) != "internal.error" {
		t.Fatalf("missing fallback store code = %q", errorCode(t, err))
	}
	if _, err := NewHybridBlobStore(HybridBlobStoreOptions{Primary: primary, LocalMirrorWrite: true}); errorCode(t, err) != "internal.error" {
		t.Fatalf("missing mirror store code = %q", errorCode(t, err))
	}
	if _, err := NewHybridBlobStore(HybridBlobStoreOptions{Primary: primary}); err != nil {
		t.Fatalf("primary-only store: %v", err)
	}
}

func equalStrings(first, second []string) bool {
	if len(first) != len(second) {
		return false
	}
	for index := range first {
		if first[index] != second[index] {
			return false
		}
	}
	return true
}
