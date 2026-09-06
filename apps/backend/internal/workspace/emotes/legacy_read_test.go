package emotes

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

type legacyReadResponse struct {
	data         []byte
	reportedKey  string
	reportedSize *int64
	reportedSHA  string
	contentType  string
	openErr      error
	closeCount   *atomic.Int32
}

type legacyReadReaderStub struct {
	mu        sync.Mutex
	responses map[string]legacyReadResponse
	calls     []string
}

func (reader *legacyReadReaderStub) OpenLegacy(_ context.Context, key string, _ int64) (platformstorage.OpenedObject, error) {
	reader.mu.Lock()
	reader.calls = append(reader.calls, key)
	response, ok := reader.responses[key]
	reader.mu.Unlock()
	if !ok {
		return platformstorage.OpenedObject{}, &platformstorage.Error{Code: "file.storage_missing", StatusCode: 404}
	}
	if response.openErr != nil {
		return platformstorage.OpenedObject{}, response.openErr
	}
	data := append([]byte(nil), response.data...)
	size := int64(len(data))
	if response.reportedSize != nil {
		size = *response.reportedSize
	}
	return platformstorage.OpenedObject{
		Object: platformstorage.Object{
			Key:         nonEmpty(response.reportedKey, key),
			ByteSize:    size,
			SHA256:      response.reportedSHA,
			ContentType: response.contentType,
		},
		Body: &legacyReadTrackedBody{Reader: bytes.NewReader(data), closeCount: response.closeCount},
	}, nil
}

func (reader *legacyReadReaderStub) callSnapshot() []string {
	reader.mu.Lock()
	defer reader.mu.Unlock()
	return append([]string(nil), reader.calls...)
}

type legacyReadTrackedBody struct {
	*bytes.Reader
	closeCount *atomic.Int32
}

func (body *legacyReadTrackedBody) Close() error {
	if body.closeCount != nil {
		body.closeCount.Add(1)
	}
	return nil
}

type legacyReadBlobStoreStub struct {
	mu      sync.Mutex
	opened  platformstorage.OpenedObject
	openErr error
	calls   []platformstorage.Object
}

func (store *legacyReadBlobStoreStub) Put(context.Context, string, io.Reader, int64, string) (platformstorage.StoredObject, error) {
	return platformstorage.StoredObject{}, errors.New("legacy read test store does not write")
}

func (store *legacyReadBlobStoreStub) Open(_ context.Context, object platformstorage.Object, _ int64) (platformstorage.OpenedObject, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.calls = append(store.calls, object)
	if store.openErr != nil {
		return store.opened, store.openErr
	}
	return store.opened, nil
}

func (store *legacyReadBlobStoreStub) Delete(context.Context, platformstorage.Object) error {
	return errors.New("legacy read test store does not delete")
}

func (store *legacyReadBlobStoreStub) callCount() int {
	store.mu.Lock()
	defer store.mu.Unlock()
	return len(store.calls)
}

func newLegacyReadService(t *testing.T, row CustomEmoteRecord, reader *legacyReadReaderStub, store platformstorage.BlobStore) (*Service, *fakeRepo) {
	t.Helper()
	repo := newFakeRepo()
	seedFakeActor(repo, "usr-emote-owner", "owner")
	repo.state.emotes[row.ID] = row
	return NewService(ServiceOptions{
		Repository:   repo,
		BlobStore:    store,
		LegacyReader: reader,
	}), repo
}

func legacyReadRow(storageKey string) CustomEmoteRecord {
	return CustomEmoteRecord{
		ID:                 "emote-legacy-1",
		UserID:             "usr-emote-owner",
		SourceType:         "upload",
		Label:              "legacy",
		NormalizedMIMEType: "",
		StorageKey:         storageKey,
	}
}

func legacyReadKeys(userID, emoteID string) (string, string) {
	return "custom-emotes/" + userID + "/" + emoteID + "/content.webp",
		"workspace/custom-emotes/" + userID + "/" + emoteID + "/content.webp"
}

func legacyReadResponseFor(data []byte) legacyReadResponse {
	return legacyReadResponse{data: append([]byte(nil), data...), contentType: "image/webp"}
}

func legacyReadDigest(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func readLegacyDelivery(t *testing.T, delivery Delivery) ([]byte, error) {
	t.Helper()
	if delivery.Body == nil {
		return nil, errors.New("delivery body is nil")
	}
	data, readErr := io.ReadAll(delivery.Body)
	closeErr := delivery.Body.Close()
	if readErr == nil {
		readErr = closeErr
	}
	return data, readErr
}

func TestReadContentLegacyNodeKeyAndNullMetadata(t *testing.T) {
	legacyKey, deterministicKey := legacyReadKeys("usr-emote-owner", "emote-legacy-1")
	content := []byte("Node historical emote bytes")
	reader := &legacyReadReaderStub{responses: map[string]legacyReadResponse{
		legacyKey:        legacyReadResponseFor(content),
		deterministicKey: {openErr: &platformstorage.Error{Code: "file.storage_missing", StatusCode: 404}},
	}}
	service, _ := newLegacyReadService(t, legacyReadRow(legacyKey), reader, nil)

	delivery, err := service.ReadContent(context.Background(), ReadContentInput{ActorID: "usr-emote-owner", EmoteID: "emote-legacy-1"})
	if err != nil {
		t.Fatal(err)
	}
	got, readErr := readLegacyDelivery(t, delivery)
	if readErr != nil || !bytes.Equal(got, content) {
		t.Fatalf("legacy NULL metadata content=%q readErr=%v", got, readErr)
	}
	if delivery.ByteSize != int64(len(content)) || delivery.ContentType != "image/webp" {
		t.Fatalf("legacy NULL metadata projection=%#v", delivery)
	}
	if calls := reader.callSnapshot(); len(calls) != 1 || calls[0] != legacyKey {
		t.Fatalf("legacy key calls=%v", calls)
	}
}

func TestReadContentLegacyTriesDeterministicNodeKeyOnlyAfterMissing(t *testing.T) {
	legacyKey, deterministicKey := legacyReadKeys("usr-emote-owner", "emote-legacy-1")
	content := []byte("deterministic legacy bytes")
	reader := &legacyReadReaderStub{responses: map[string]legacyReadResponse{
		legacyKey:        {openErr: &platformstorage.Error{Code: "file.storage_missing", StatusCode: 404}},
		deterministicKey: legacyReadResponseFor(content),
	}}
	service, _ := newLegacyReadService(t, legacyReadRow(legacyKey), reader, nil)

	delivery, err := service.ReadContent(context.Background(), ReadContentInput{ActorID: "usr-emote-owner", EmoteID: "emote-legacy-1"})
	if err != nil {
		t.Fatal(err)
	}
	got, readErr := readLegacyDelivery(t, delivery)
	if readErr != nil || !bytes.Equal(got, content) {
		t.Fatalf("deterministic fallback content=%q readErr=%v", got, readErr)
	}
	calls := reader.callSnapshot()
	if len(calls) != 2 || calls[0] != legacyKey || calls[1] != deterministicKey {
		t.Fatalf("deterministic fallback calls=%v", calls)
	}
}

func TestReadContentLegacyAuthorizesBeforeReaderAndRejectsArbitraryKey(t *testing.T) {
	reader := &legacyReadReaderStub{responses: map[string]legacyReadResponse{}}
	row := legacyReadRow("custom-emotes/usr-emote-owner/emote-legacy-1/other.webp")
	service, repo := newLegacyReadService(t, row, reader, nil)

	if _, err := service.ReadContent(context.Background(), ReadContentInput{ActorID: "usr-unknown", EmoteID: row.ID}); !isCode(err, CodeAuthRequired) {
		t.Fatalf("unauthorized read=%v", err)
	}
	if calls := reader.callSnapshot(); len(calls) != 0 {
		t.Fatalf("unauthorized reader calls=%v", calls)
	}
	seedFakeActor(repo, "usr-emote-member", "member")
	if _, err := service.ReadContent(context.Background(), ReadContentInput{ActorID: "usr-emote-member", EmoteID: row.ID}); !isCode(err, CodePermissionDenied) {
		t.Fatalf("invisible read=%v", err)
	}
	if calls := reader.callSnapshot(); len(calls) != 0 {
		t.Fatalf("invisible reader calls=%v", calls)
	}
	if _, err := service.ReadContent(context.Background(), ReadContentInput{ActorID: "usr-emote-owner", EmoteID: row.ID}); !isCode(err, CodeFileInvalidStorageKey) {
		t.Fatalf("arbitrary key read=%v", err)
	}
	if calls := reader.callSnapshot(); len(calls) != 0 {
		t.Fatalf("arbitrary key reader calls=%v", calls)
	}
}

func TestReadContentCanonicalMissingOnlyFallsBackToLegacy(t *testing.T) {
	legacyKey, _ := legacyReadKeys("usr-emote-owner", "emote-legacy-1")
	content := []byte("canonical row missing")
	reader := &legacyReadReaderStub{responses: map[string]legacyReadResponse{legacyKey: legacyReadResponseFor(content)}}
	row := legacyReadRow(legacyKey)
	row.StorageObjectID = "wso-legacy-missing"
	service, _ := newLegacyReadService(t, row, reader, nil)

	delivery, err := service.ReadContent(context.Background(), ReadContentInput{ActorID: row.UserID, EmoteID: row.ID})
	if err != nil {
		t.Fatal(err)
	}
	got, readErr := readLegacyDelivery(t, delivery)
	if readErr != nil || !bytes.Equal(got, content) {
		t.Fatalf("missing canonical fallback content=%q readErr=%v", got, readErr)
	}
}

func TestReadContentCanonicalTombstoneAndMismatchNeverFallBack(t *testing.T) {
	legacyKey, _ := legacyReadKeys("usr-emote-owner", "emote-legacy-1")
	content := []byte("legacy must stay unreachable")
	for _, test := range []struct {
		name   string
		object StorageObjectRecord
	}{
		{
			name: "tombstone",
			object: StorageObjectRecord{
				ID: "wso-legacy-tombstone", SHA256: legacyReadDigest(content),
				ObjectKey: mustLegacyCanonicalKey(t, content), ByteSize: int64(len(content)),
				DeletedAt: timePtr(time.Now().UTC()),
			},
		},
		{
			name: "resource digest mismatch",
			object: StorageObjectRecord{
				ID: "wso-legacy-mismatch", SHA256: legacyReadDigest(content),
				ObjectKey: mustLegacyCanonicalKey(t, content), ByteSize: int64(len(content)),
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			reader := &legacyReadReaderStub{responses: map[string]legacyReadResponse{legacyKey: legacyReadResponseFor(content)}}
			row := legacyReadRow(legacyKey)
			row.StorageObjectID = test.object.ID
			row.SHA256 = strings.Repeat("f", 64)
			service, repo := newLegacyReadService(t, row, reader, nil)
			repo.state.objects[test.object.ID] = test.object

			if _, err := service.ReadContent(context.Background(), ReadContentInput{ActorID: row.UserID, EmoteID: row.ID}); !isCode(err, CodeEmoteStorageMismatch) {
				t.Fatalf("canonical protected read=%v", err)
			}
			if calls := reader.callSnapshot(); len(calls) != 0 {
				t.Fatalf("canonical protected reader calls=%v", calls)
			}
		})
	}
}

func TestReadContentCanonicalPhysicalMissingFallsBackButOtherErrorsDoNot(t *testing.T) {
	legacyKey, _ := legacyReadKeys("usr-emote-owner", "emote-legacy-1")
	content := []byte("physical canonical missing")
	digest := legacyReadDigest(content)
	key, err := platformstorage.CanonicalObjectKey(digest)
	if err != nil {
		t.Fatal(err)
	}
	object := StorageObjectRecord{ID: "wso-physical-missing", SHA256: digest, ObjectKey: key, ByteSize: int64(len(content)), ContentType: "image/webp"}
	for _, test := range []struct {
		name       string
		openErr    error
		wantReader bool
	}{
		{name: "missing", openErr: &platformstorage.Error{Code: "file.storage_missing", StatusCode: 404}, wantReader: true},
		{name: "provider unavailable", openErr: &platformstorage.Error{Code: "file.storage_unavailable", StatusCode: 503}, wantReader: false},
		{name: "content mismatch", openErr: &platformstorage.Error{Code: "file.storage_mismatch", StatusCode: 500}, wantReader: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			reader := &legacyReadReaderStub{responses: map[string]legacyReadResponse{legacyKey: legacyReadResponseFor(content)}}
			store := &legacyReadBlobStoreStub{openErr: test.openErr}
			row := legacyReadRow(legacyKey)
			row.StorageObjectID = object.ID
			row.ByteSize = int64PointerValue(object.ByteSize)
			row.SHA256 = digest
			service, repo := newLegacyReadService(t, row, reader, store)
			repo.state.objects[object.ID] = object

			delivery, readErr := service.ReadContent(context.Background(), ReadContentInput{ActorID: row.UserID, EmoteID: row.ID})
			if test.wantReader {
				if readErr != nil {
					t.Fatal(readErr)
				}
				got, bodyErr := readLegacyDelivery(t, delivery)
				if bodyErr != nil || !bytes.Equal(got, content) {
					t.Fatalf("fallback content=%q bodyErr=%v", got, bodyErr)
				}
			} else if readErr == nil {
				_ = delivery.Body.Close()
				t.Fatal("non-missing canonical error was accepted")
			}
			if got := len(reader.callSnapshot()); got != boolInt(test.wantReader) {
				t.Fatalf("fallback reader calls=%d want=%d", got, boolInt(test.wantReader))
			}
			if store.callCount() != 1 {
				t.Fatalf("canonical open calls=%d", store.callCount())
			}
		})
	}
}

func TestReadContentCanonicalFallbackRejectsSameSizeBytesAgainstObjectDigest(t *testing.T) {
	legacyKey, _ := legacyReadKeys("usr-emote-owner", "emote-legacy-1")
	content := []byte("canonical object identity")
	wrongSameSize := bytes.Repeat([]byte("x"), len(content))
	digest := legacyReadDigest(content)
	key, err := platformstorage.CanonicalObjectKey(digest)
	if err != nil {
		t.Fatal(err)
	}
	object := StorageObjectRecord{
		ID: "wso-fallback-identity", SHA256: digest, ObjectKey: key,
		ByteSize: int64(len(content)), ContentType: "image/webp",
	}
	reader := &legacyReadReaderStub{responses: map[string]legacyReadResponse{
		legacyKey: legacyReadResponseFor(wrongSameSize),
	}}
	store := &legacyReadBlobStoreStub{openErr: &platformstorage.Error{Code: "file.storage_missing", StatusCode: 404}}
	row := legacyReadRow(legacyKey)
	row.StorageObjectID = object.ID
	service, repo := newLegacyReadService(t, row, reader, store)
	repo.state.objects[object.ID] = object

	if _, err := service.ReadContent(context.Background(), ReadContentInput{ActorID: row.UserID, EmoteID: row.ID}); !isCode(err, CodeEmoteStorageMismatch) {
		t.Fatalf("same-size fallback content was accepted: %v", err)
	}
}

func TestReadContentLegacyValidatesKnownDigestBeforeDelivery(t *testing.T) {
	legacyKey, _ := legacyReadKeys("usr-emote-owner", "emote-legacy-1")
	content := []byte("known legacy digest")
	digest := legacyReadDigest(content)
	wrongSameSize := bytes.Repeat([]byte("x"), len(content))
	for _, test := range []struct {
		name         string
		data         []byte
		reportedSize *int64
		reportedSHA  string
		wantReadErr  bool
	}{
		{name: "missing S3 metadata but matching bytes", data: content, wantReadErr: false},
		{name: "wrong bytes with missing metadata", data: wrongSameSize, wantReadErr: true},
		{name: "reported size mismatch", data: content, reportedSize: int64PointerValue(int64(len(content) + 1)), wantReadErr: true},
		{name: "reported digest mismatch", data: content, reportedSHA: strings.Repeat("a", 64), wantReadErr: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := legacyReadResponseFor(test.data)
			response.reportedSize = test.reportedSize
			response.reportedSHA = test.reportedSHA
			reader := &legacyReadReaderStub{responses: map[string]legacyReadResponse{legacyKey: response}}
			row := legacyReadRow(legacyKey)
			row.ByteSize = int64PointerValue(int64(len(content)))
			row.SHA256 = digest
			service, _ := newLegacyReadService(t, row, reader, nil)

			delivery, err := service.ReadContent(context.Background(), ReadContentInput{ActorID: row.UserID, EmoteID: row.ID})
			if test.name == "wrong bytes with missing metadata" || test.name == "reported size mismatch" || test.name == "reported digest mismatch" {
				if !isCode(err, CodeEmoteStorageMismatch) {
					t.Fatalf("pre-delivery mismatch=%v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			_, readErr := readLegacyDelivery(t, delivery)
			if test.wantReadErr != (readErr != nil) || (readErr != nil && !isCode(readErr, CodeEmoteStorageMismatch)) {
				t.Fatalf("delivery readErr=%v wantMismatch=%v", readErr, test.wantReadErr)
			}
		})
	}
}

func TestReadContentLegacyRejectsMalformedMetadataAndSupportsCloneSource(t *testing.T) {
	legacyKey, _ := legacyReadKeys("usr-emote-owner", "emote-legacy-1")
	content := []byte("clone source bytes")
	for _, test := range []struct {
		name   string
		mutate func(*CustomEmoteRecord)
	}{
		{name: "zero size", mutate: func(row *CustomEmoteRecord) { row.ByteSize = int64PointerValue(0) }},
		{name: "negative size", mutate: func(row *CustomEmoteRecord) { row.ByteSize = int64PointerValue(-1) }},
		{name: "invalid digest", mutate: func(row *CustomEmoteRecord) { row.SHA256 = "not-a-sha" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			reader := &legacyReadReaderStub{responses: map[string]legacyReadResponse{legacyKey: legacyReadResponseFor(content)}}
			row := legacyReadRow(legacyKey)
			test.mutate(&row)
			service, _ := newLegacyReadService(t, row, reader, nil)
			if _, err := service.ReadContent(context.Background(), ReadContentInput{ActorID: row.UserID, EmoteID: row.ID}); !isCode(err, CodeEmoteStorageMismatch) {
				t.Fatalf("malformed metadata=%v", err)
			}
			if calls := reader.callSnapshot(); len(calls) != 0 {
				t.Fatalf("malformed metadata reader calls=%v", calls)
			}
		})
	}

	removedReader := &legacyReadReaderStub{responses: map[string]legacyReadResponse{legacyKey: legacyReadResponseFor(content)}}
	removedRow := CustomEmoteRecord{
		ID: "emote-legacy-1", UserID: "usr-emote-owner", SourceType: "upload",
	}
	removedAt := time.Now().UTC()
	removedRow.RemovedAt = &removedAt
	removedService, _ := newLegacyReadService(t, removedRow, removedReader, nil)
	if _, err := removedService.ReadContent(context.Background(), ReadContentInput{ActorID: removedRow.UserID, EmoteID: removedRow.ID}); !isCode(err, CodeEmoteNotFound) {
		t.Fatalf("removed emote read=%v", err)
	}
	if calls := removedReader.callSnapshot(); len(calls) != 0 {
		t.Fatalf("removed emote reader calls=%v", calls)
	}

	retainedReader := &legacyReadReaderStub{responses: map[string]legacyReadResponse{legacyKey: legacyReadResponseFor(content)}}
	retainedRow := legacyReadRow(legacyKey)
	retainedAt := time.Now().UTC()
	retainedRow.RemovedAt = &retainedAt
	retainedService, _ := newLegacyReadService(t, retainedRow, retainedReader, nil)
	retainedDelivery, err := retainedService.ReadContent(context.Background(), ReadContentInput{ActorID: retainedRow.UserID, EmoteID: retainedRow.ID})
	if err != nil {
		t.Fatalf("removed emote with retained storage read=%v", err)
	}
	got, readErr := readLegacyDelivery(t, retainedDelivery)
	if readErr != nil || !bytes.Equal(got, content) {
		t.Fatalf("removed emote with retained storage content=%q readErr=%v", got, readErr)
	}

	reader := &legacyReadReaderStub{responses: map[string]legacyReadResponse{legacyKey: legacyReadResponseFor(content)}}
	service, repo := newLegacyReadService(t, CustomEmoteRecord{
		ID: "emote-clone", UserID: "usr-emote-owner", SourceCustomEmoteID: "emote-source",
	}, reader, nil)
	repo.state.emotes["emote-source"] = legacyReadRow(legacyKey)
	delivery, err := service.ReadContent(context.Background(), ReadContentInput{ActorID: "usr-emote-owner", EmoteID: "emote-clone"})
	if err != nil {
		t.Fatal(err)
	}
	got, readErr = readLegacyDelivery(t, delivery)
	if readErr != nil || !bytes.Equal(got, content) {
		t.Fatalf("clone source content=%q readErr=%v", got, readErr)
	}
}

func mustLegacyCanonicalKey(t *testing.T, content []byte) string {
	t.Helper()
	key, err := platformstorage.CanonicalObjectKey(legacyReadDigest(content))
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func int64PointerValue(value int64) *int64 {
	return &value
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func timePtr(value time.Time) *time.Time {
	return &value
}
