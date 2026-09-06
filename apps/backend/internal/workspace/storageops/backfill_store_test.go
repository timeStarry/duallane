package storageops

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

func TestBackfillStoreAdapterUsesBoundedPlatformLegacyReader(t *testing.T) {
	ctx := context.Background()
	legacy := &recordingLegacyReader{
		body:        []byte("legacy attachment"),
		objectKey:   "legacy/attachments/att-1",
		contentType: "",
	}
	canonical := &fakeAdapterBlobStore{}
	adapter, err := NewBackfillStoreAdapter(BackfillStoreAdapterOptions{
		Canonical:       canonical,
		Legacy:          legacy,
		LegacyKeyPrefix: "legacy/attachments/",
		MaxLegacyBytes:  1024,
	})
	if err != nil {
		t.Fatal(err)
	}

	content := legacy.body
	expectedSize := int64(len(content))
	item := BackfillItem{
		Kind:             "attachment",
		ResourceID:       "att-1",
		LegacyStorageKey: "legacy/attachments/att-1",
		ContentType:      "text/plain",
		ExpectedByteSize: &expectedSize,
	}
	inspection, err := adapter.InspectLegacy(ctx, item)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(content)
	if inspection.ByteSize != expectedSize || inspection.SHA256 != hex.EncodeToString(digest[:]) {
		t.Fatalf("inspection = %#v", inspection)
	}
	if legacy.calls != 1 || legacy.lastMaxBytes != 1024 {
		t.Fatalf("legacy calls=%d max=%d", legacy.calls, legacy.lastMaxBytes)
	}

	opened, err := adapter.OpenLegacy(ctx, item)
	if err != nil {
		t.Fatal(err)
	}
	openedContent, readErr := io.ReadAll(opened.Body)
	closeErr := opened.Body.Close()
	if readErr != nil || closeErr != nil || !bytes.Equal(openedContent, content) {
		t.Fatalf("opened content=%q read=%v close=%v", openedContent, readErr, closeErr)
	}
	if opened.Object.Key != item.LegacyStorageKey || opened.Object.ByteSize != expectedSize || opened.Object.ContentType != item.ContentType {
		t.Fatalf("opened object = %#v", opened.Object)
	}
	if legacy.calls != 2 || legacy.lastMaxBytes != 1024 {
		t.Fatalf("legacy calls=%d max=%d", legacy.calls, legacy.lastMaxBytes)
	}
}

func TestBackfillStoreAdapterBoundsLegacyBodyAndRejectsOverage(t *testing.T) {
	legacy := &recordingLegacyReader{
		body:           []byte("12345"),
		objectKey:      "legacy/attachments/att-1",
		objectByteSize: 4,
		hasObjectSize:  true,
	}
	adapter, err := NewBackfillStoreAdapter(BackfillStoreAdapterOptions{
		Canonical:       &fakeAdapterBlobStore{},
		Legacy:          legacy,
		LegacyKeyPrefix: "legacy/attachments",
		MaxLegacyBytes:  4,
	})
	if err != nil {
		t.Fatal(err)
	}
	item := BackfillItem{Kind: "attachment", ResourceID: "att-1", LegacyStorageKey: legacy.objectKey}

	opened, err := adapter.OpenLegacy(context.Background(), item)
	if err != nil {
		t.Fatal(err)
	}
	bounded, readErr := io.ReadAll(opened.Body)
	closeErr := opened.Body.Close()
	if readErr != nil || closeErr != nil || string(bounded) != "12345" {
		t.Fatalf("bounded body=%q read=%v close=%v", bounded, readErr, closeErr)
	}
	if len(bounded) != 5 || legacy.lastMaxBytes != 4 {
		t.Fatalf("body was not bounded to max+1: len=%d max=%d", len(bounded), legacy.lastMaxBytes)
	}

	_, err = adapter.InspectLegacy(context.Background(), item)
	if BackfillErrorCode(err) != "storageops.legacy_too_large" {
		t.Fatalf("inspect error code=%q err=%v", BackfillErrorCode(err), err)
	}
}

func TestBackfillStoreAdapterChecksExpectedMetadataAndClosesRejectedBody(t *testing.T) {
	tests := []struct {
		name        string
		contentType string
		expected    *int64
		wantCode    string
	}{
		{name: "size", expected: int64Pointer(3), wantCode: "storageops.legacy_size_mismatch"},
		{name: "content type", contentType: "image/png", expected: int64Pointer(4), wantCode: "storageops.legacy_content_type_mismatch"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			legacy := &recordingLegacyReader{
				body:        []byte("data"),
				objectKey:   "legacy/attachments/att-1",
				contentType: test.contentType,
			}
			adapter, err := NewBackfillStoreAdapter(BackfillStoreAdapterOptions{
				Canonical:       &fakeAdapterBlobStore{},
				Legacy:          legacy,
				LegacyKeyPrefix: "legacy/attachments",
				MaxLegacyBytes:  64,
			})
			if err != nil {
				t.Fatal(err)
			}
			item := BackfillItem{
				Kind:             "attachment",
				ResourceID:       "att-1",
				LegacyStorageKey: legacy.objectKey,
				ContentType:      "text/plain",
				ExpectedByteSize: test.expected,
			}
			_, err = adapter.OpenLegacy(context.Background(), item)
			if BackfillErrorCode(err) != test.wantCode {
				t.Fatalf("error code=%q err=%v", BackfillErrorCode(err), err)
			}
			if legacy.lastBody == nil || !legacy.lastBody.closed {
				t.Fatal("rejected legacy body was not closed")
			}
		})
	}
}

func TestBackfillStoreAdapterRejectsOutOfScopeKeysBeforeSource(t *testing.T) {
	legacy := &recordingLegacyReader{body: []byte("data"), objectKey: "legacy/attachments/att-1"}
	adapter, err := NewBackfillStoreAdapter(BackfillStoreAdapterOptions{
		Canonical:       &fakeAdapterBlobStore{},
		Legacy:          legacy,
		LegacyKeyPrefix: "legacy/attachments",
		MaxLegacyBytes:  64,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range []BackfillItem{
		{Kind: "attachment", ResourceID: "att-1", LegacyStorageKey: "legacy/other/att-1"},
		{Kind: "attachment", ResourceID: "att-1", LegacyStorageKey: "legacy/attachments/../secret"},
		{Kind: "attachment", ResourceID: "att-1", LegacyStorageKey: "workspace/objects/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
		{Kind: "unknown", ResourceID: "att-1", LegacyStorageKey: "legacy/attachments/att-1"},
	} {
		if _, err := adapter.OpenLegacy(context.Background(), item); err == nil {
			t.Fatalf("accepted invalid item %#v", item)
		}
	}
	if legacy.calls != 0 {
		t.Fatalf("invalid legacy requests reached source: %d", legacy.calls)
	}
}

func TestBackfillStoreAdapterConstructorAndCanonicalDelegation(t *testing.T) {
	legacy := &recordingLegacyReader{body: []byte("data"), objectKey: "legacy/attachments/att-1"}
	canonical := &fakeAdapterBlobStore{}
	for _, test := range []struct {
		name    string
		options BackfillStoreAdapterOptions
		code    string
	}{
		{name: "canonical required", options: BackfillStoreAdapterOptions{Legacy: legacy, LegacyKeyPrefix: "legacy"}, code: "storageops.canonical_store_required"},
		{name: "legacy required", options: BackfillStoreAdapterOptions{Canonical: canonical, LegacyKeyPrefix: "legacy"}, code: "storageops.legacy_source_required"},
		{name: "scope required", options: BackfillStoreAdapterOptions{Canonical: canonical, Legacy: legacy}, code: "storageops.legacy_scope_invalid"},
		{name: "limit bounded", options: BackfillStoreAdapterOptions{Canonical: canonical, Legacy: legacy, LegacyKeyPrefix: "legacy", MaxLegacyBytes: storage.DefaultMaxObjectBytes + 1}, code: "storageops.legacy_limit_invalid"},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := NewBackfillStoreAdapter(test.options)
			if BackfillErrorCode(err) != test.code {
				t.Fatalf("error code=%q err=%v", BackfillErrorCode(err), err)
			}
		})
	}

	adapter, err := NewBackfillStoreAdapter(BackfillStoreAdapterOptions{
		Canonical:       canonical,
		Legacy:          legacy,
		LegacyKeyPrefix: "legacy",
		MaxLegacyBytes:  64,
	})
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("canonical")
	digest := sha256.Sum256(content)
	digestText := hex.EncodeToString(digest[:])
	key, err := storage.CanonicalObjectKey(digestText)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := adapter.Put(context.Background(), key, bytes.NewReader(content), int64(len(content)), digestText)
	if err != nil {
		t.Fatal(err)
	}
	if canonical.puts != 1 || stored.Object.Key != key {
		t.Fatalf("stored=%#v puts=%d", stored, canonical.puts)
	}
	opened, err := adapter.Open(context.Background(), stored.Object, storage.DefaultMaxObjectBytes)
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Body.Close()
	if got, err := io.ReadAll(opened.Body); err != nil || !bytes.Equal(got, content) {
		t.Fatalf("canonical body=%q err=%v", got, err)
	}
	if canonical.opens != 1 {
		t.Fatalf("canonical opens=%d", canonical.opens)
	}
}

type recordingLegacyReader struct {
	body           []byte
	objectKey      string
	contentType    string
	objectByteSize int64
	hasObjectSize  bool
	calls          int
	lastMaxBytes   int64
	lastBody       *trackingReadCloser
}

func (r *recordingLegacyReader) OpenLegacy(_ context.Context, key string, maxBytes int64) (storage.OpenedObject, error) {
	r.calls++
	r.lastMaxBytes = maxBytes
	if key != r.objectKey {
		return storage.OpenedObject{}, errors.New("unexpected legacy key")
	}
	r.lastBody = &trackingReadCloser{Reader: bytes.NewReader(r.body)}
	byteSize := int64(len(r.body))
	if r.hasObjectSize {
		byteSize = r.objectByteSize
	}
	return storage.OpenedObject{
		Object: storage.Object{Key: key, ByteSize: byteSize, ContentType: r.contentType},
		Body:   r.lastBody,
	}, nil
}

type trackingReadCloser struct {
	*bytes.Reader
	closed bool
}

func (r *trackingReadCloser) Close() error {
	r.closed = true
	return nil
}

type fakeAdapterBlobStore struct {
	objects map[string][]byte
	puts    int
	opens   int
}

func (s *fakeAdapterBlobStore) Put(_ context.Context, key string, source io.Reader, expectedSize int64, expectedSHA256 string) (storage.StoredObject, error) {
	content, err := io.ReadAll(source)
	if err != nil {
		return storage.StoredObject{}, err
	}
	digest := sha256.Sum256(content)
	if int64(len(content)) != expectedSize || hex.EncodeToString(digest[:]) != expectedSHA256 {
		return storage.StoredObject{}, errors.New("canonical metadata mismatch")
	}
	if s.objects == nil {
		s.objects = make(map[string][]byte)
	}
	s.objects[key] = append([]byte(nil), content...)
	s.puts++
	return storage.StoredObject{Object: storage.Object{Key: key, SHA256: expectedSHA256, ByteSize: expectedSize}}, nil
}

func (s *fakeAdapterBlobStore) Open(_ context.Context, object storage.Object, _ int64) (storage.OpenedObject, error) {
	content, ok := s.objects[object.Key]
	if !ok {
		return storage.OpenedObject{}, &storage.Error{Code: "file.storage_missing"}
	}
	s.opens++
	return storage.OpenedObject{Object: object, Body: io.NopCloser(bytes.NewReader(content))}, nil
}

func (s *fakeAdapterBlobStore) Delete(context.Context, storage.Object) error {
	return errors.New("delete is not part of the adapter contract")
}

func int64Pointer(value int64) *int64 {
	return &value
}

var _ storage.LegacyReader = (*recordingLegacyReader)(nil)
var _ storage.BlobStore = (*fakeAdapterBlobStore)(nil)
var _ = strings.TrimSpace
