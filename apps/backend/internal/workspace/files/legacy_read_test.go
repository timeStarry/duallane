package files

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type fileLegacyResponse struct {
	content     []byte
	err         error
	body        bool
	objectKey   string
	byteSize    int64
	hasByteSize bool
	digest      string
	contentType string
}

func legacyReadResponse(content []byte) fileLegacyResponse {
	digest := sha256.Sum256(content)
	return fileLegacyResponse{content: content, body: true, byteSize: int64(len(content)), hasByteSize: true, digest: hex.EncodeToString(digest[:])}
}

type fileLegacyReaderStub struct {
	mu        sync.Mutex
	responses map[string]fileLegacyResponse
	calls     []string
	maxBytes  []int64
	bodies    []*trackingFileBody
}

func (r *fileLegacyReaderStub) OpenLegacy(_ context.Context, key string, maxBytes int64) (platformstorage.OpenedObject, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, key)
	r.maxBytes = append(r.maxBytes, maxBytes)
	response, ok := r.responses[key]
	if !ok {
		return platformstorage.OpenedObject{}, &platformstorage.Error{Code: "file.storage_missing", Message: "missing", StatusCode: 404}
	}
	opened := platformstorage.OpenedObject{}
	if response.body {
		objectKey := response.objectKey
		if objectKey == "" {
			objectKey = key
		}
		byteSize := response.byteSize
		if !response.hasByteSize {
			byteSize = int64(len(response.content))
		}
		body := &trackingFileBody{Reader: bytes.NewReader(response.content)}
		r.bodies = append(r.bodies, body)
		opened = platformstorage.OpenedObject{Object: platformstorage.Object{
			Key: objectKey, SHA256: response.digest, ByteSize: byteSize, ContentType: response.contentType,
		}, Body: body}
	}
	return opened, response.err
}

type fileReadBlobStore struct {
	mu          sync.Mutex
	openErr     error
	content     []byte
	contentType string
	objectKey   string
	byteSize    int64
	wrongKey    bool
	wrongSize   bool
	openCalls   int
	bodies      []*trackingFileBody
}

func (s *fileReadBlobStore) Put(context.Context, string, io.Reader, int64, string) (platformstorage.StoredObject, error) {
	return platformstorage.StoredObject{}, errors.New("put is not part of the read fixture")
}

func (s *fileReadBlobStore) Open(_ context.Context, object platformstorage.Object, _ int64) (platformstorage.OpenedObject, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.openCalls++
	if s.openErr != nil {
		return platformstorage.OpenedObject{}, s.openErr
	}
	key := object.Key
	if s.objectKey != "" {
		key = s.objectKey
	}
	if s.wrongKey {
		key += "/wrong"
	}
	size := object.ByteSize
	if s.byteSize != 0 {
		size = s.byteSize
	}
	if s.wrongSize {
		size++
	}
	body := &trackingFileBody{Reader: bytes.NewReader(s.content)}
	s.bodies = append(s.bodies, body)
	return platformstorage.OpenedObject{Object: platformstorage.Object{Key: key, ByteSize: size, ContentType: s.contentType}, Body: body}, nil
}

func (s *fileReadBlobStore) Delete(context.Context, platformstorage.Object) error {
	return errors.New("delete is not part of the read fixture")
}

type trackingFileBody struct {
	io.Reader
	closed bool
}

func (b *trackingFileBody) Close() error {
	b.closed = true
	return nil
}

func TestOpenAttachmentContentCanonicalFirstAndMissingOnlyLegacyFallback(t *testing.T) {
	content := []byte("canonical")
	record := legacyReadAttachment(content)
	digest := testSHA256(content)
	canonicalKey, err := platformstorage.CanonicalObjectKey(digest)
	if err != nil {
		t.Fatal(err)
	}
	record.StorageObject = &StorageObjectRecord{
		ID: "wso_canonical", SHA256: digest, ObjectKey: canonicalKey,
		ByteSize: int64(len(content)), ContentType: "text/plain", CreatedAt: time.Now().UTC(),
	}
	record.StorageObjectID = record.StorageObject.ID
	repo := newFakeFileRepo()
	repo.state.attachments[record.ID] = &record
	legacy := &fileLegacyReaderStub{responses: map[string]fileLegacyResponse{
		record.StorageKey: legacyReadResponse([]byte("fallback!")),
	}}
	store := &fileReadBlobStore{content: content, contentType: "text/plain"}
	service := testService(t, repo, store)
	service.legacyReader = legacy

	opened, err := service.OpenAttachmentContent(context.Background(), OpenAttachmentInput{
		ActorID: "usr_owner", AttachmentID: record.ID, MaxBytes: int64(len(content)),
	})
	if err != nil {
		t.Fatalf("canonical open: %v", err)
	}
	got, readErr := io.ReadAll(opened.Body)
	_ = opened.Body.Close()
	if readErr != nil || string(got) != string(content) {
		t.Fatalf("canonical bytes = %q, read err = %v", got, readErr)
	}
	if store.openCalls != 1 || len(legacy.calls) != 0 {
		t.Fatalf("canonical-first calls = store %d, legacy %d", store.openCalls, len(legacy.calls))
	}

	store.openErr = &platformstorage.Error{Code: "file.storage_missing", Message: "missing", StatusCode: 404}
	opened, err = service.OpenAttachmentContent(context.Background(), OpenAttachmentInput{
		ActorID: "usr_owner", AttachmentID: record.ID, MaxBytes: int64(len(content)),
	})
	if errorCode(err) != CodeFileStorageMismatch {
		t.Fatalf("different legacy bytes with same size code = %q, err = %v", errorCode(err), err)
	}
	if opened.Body != nil || len(legacy.calls) != 1 || legacy.calls[0] != record.StorageKey || !legacy.bodies[0].closed {
		t.Fatalf("legacy hash mismatch opened=%#v calls=%v bodies=%#v", opened, legacy.calls, legacy.bodies)
	}

	legacy.responses[record.StorageKey] = legacyReadResponse(content)
	opened, err = service.OpenAttachmentContent(context.Background(), OpenAttachmentInput{
		ActorID: "usr_owner", AttachmentID: record.ID, MaxBytes: int64(len(content)),
	})
	if err != nil {
		t.Fatalf("matching canonical legacy fallback: %v", err)
	}
	got, readErr = io.ReadAll(opened.Body)
	_ = opened.Body.Close()
	if readErr != nil || string(got) != string(content) || len(legacy.calls) != 2 {
		t.Fatalf("legacy fallback bytes=%q err=%v calls=%v", got, readErr, legacy.calls)
	}

	// A real old S3 object may not report digest metadata. The bounded stream
	// wrapper verifies the actual bytes at EOF without buffering the object.
	legacy.responses[record.StorageKey] = fileLegacyResponse{
		content: content, body: true, byteSize: int64(len(content)), hasByteSize: true,
	}
	legacy.calls = nil
	opened, err = service.OpenAttachmentContent(context.Background(), OpenAttachmentInput{
		ActorID: "usr_owner", AttachmentID: record.ID, MaxBytes: int64(len(content)),
	})
	if err != nil {
		t.Fatalf("missing legacy digest should defer verification: %v", err)
	}
	got, readErr = io.ReadAll(opened.Body)
	_ = opened.Body.Close()
	if readErr != nil || string(got) != string(content) || len(legacy.calls) != 1 {
		t.Fatalf("missing legacy digest bytes=%q err=%v calls=%v", got, readErr, legacy.calls)
	}

	// The same-size wrong body must fail when the bounded stream reaches EOF.
	legacy.responses[record.StorageKey] = fileLegacyResponse{
		content: []byte("fallback!"), body: true, byteSize: int64(len(content)), hasByteSize: true,
	}
	legacy.calls = nil
	opened, err = service.OpenAttachmentContent(context.Background(), OpenAttachmentInput{
		ActorID: "usr_owner", AttachmentID: record.ID, MaxBytes: int64(len(content)),
	})
	if err != nil {
		t.Fatalf("missing legacy digest wrong body open: %v", err)
	}
	got, readErr = io.ReadAll(opened.Body)
	_ = opened.Body.Close()
	if errorCode(readErr) != CodeFileStorageMismatch || string(got) != "fallback!" || len(legacy.calls) != 1 || !legacy.bodies[len(legacy.bodies)-1].closed {
		t.Fatalf("missing legacy digest mismatch bytes=%q err=%v calls=%v bodies=%#v", got, readErr, legacy.calls, legacy.bodies)
	}

	// An unbound registry row is allowed to use the legacy seam directly, but
	// must not attempt a canonical store read first.
	record.StorageObject = nil
	record.StorageObjectID = ""
	record.StorageKey = "workspace/attachments/spc_default/attachment-legacy/content"
	repo.state.attachments[record.ID] = &record
	legacy.responses[record.StorageKey] = legacyReadResponse([]byte("legacy!!!"))
	store.openErr = errors.New("canonical store must not be called for an unbound row")
	store.openCalls = 0
	legacy.calls = nil
	opened, err = service.OpenAttachmentContent(context.Background(), OpenAttachmentInput{
		ActorID: "usr_owner", AttachmentID: record.ID, MaxBytes: 32,
	})
	if err != nil {
		t.Fatalf("unbound legacy open: %v", err)
	}
	got, readErr = io.ReadAll(opened.Body)
	_ = opened.Body.Close()
	if readErr != nil || string(got) != "legacy!!!" || len(legacy.calls) != 1 || store.openCalls != 0 {
		t.Fatalf("unbound legacy bytes=%q err=%v calls=%v storeCalls=%d", got, readErr, legacy.calls, store.openCalls)
	}
}

func TestOpenAttachmentRefusesTombstonedCanonicalBinding(t *testing.T) {
	content := []byte("legacy tombstone")
	record := legacyReadAttachment(content)
	digest := testSHA256(content)
	canonicalKey, err := platformstorage.CanonicalObjectKey(digest)
	if err != nil {
		t.Fatal(err)
	}
	deletedAt := time.Unix(1700000001, 0).UTC()
	record.StorageObjectID = "wso_tombstone"
	record.StorageObject = &StorageObjectRecord{
		ID: record.StorageObjectID, SHA256: digest, ObjectKey: canonicalKey,
		ByteSize: int64(len(content)), ContentType: record.MIMEType,
		CreatedAt: time.Unix(1700000000, 0).UTC(), DeletedAt: &deletedAt,
	}
	repo := newFakeFileRepo()
	repo.state.attachments[record.ID] = &record
	legacy := &fileLegacyReaderStub{responses: map[string]fileLegacyResponse{
		record.StorageKey: legacyReadResponse(content),
	}}
	service := testService(t, repo, nil)
	service.legacyReader = legacy

	if opened, err := service.OpenAttachmentContent(context.Background(), OpenAttachmentInput{
		ActorID: "usr_owner", AttachmentID: record.ID, MaxBytes: int64(len(content)),
	}); errorCode(err) != CodeFileStorageMismatch || opened.Body != nil {
		t.Fatalf("explicit tombstone opened=%#v code=%q err=%v", opened, errorCode(err), err)
	}
	if len(legacy.calls) != 0 {
		t.Fatalf("explicit tombstone fell back to legacy: %v", legacy.calls)
	}

	// PG attachment projections retain storage_object_id while their
	// deleted_at-filtered LEFT JOIN leaves StorageObject nil. That shape is
	// also a bound tombstone and must not be mistaken for an unbound legacy row.
	record.StorageObject = nil
	repo.state.attachments[record.ID] = &record
	if opened, err := service.OpenAttachmentContent(context.Background(), OpenAttachmentInput{
		ActorID: "usr_owner", AttachmentID: record.ID, MaxBytes: int64(len(content)),
	}); errorCode(err) != CodeFileStorageMismatch || opened.Body != nil {
		t.Fatalf("filtered tombstone opened=%#v code=%q err=%v", opened, errorCode(err), err)
	}
	if len(legacy.calls) != 0 {
		t.Fatalf("filtered tombstone fell back to legacy: %v", legacy.calls)
	}
}

func TestLogicalAttachmentNotFoundMatchesNodeStatus(t *testing.T) {
	service := testService(t, newFakeFileRepo(), nil)
	_, err := service.GetDownloadableAttachment(context.Background(), "usr_owner", "missing-attachment", auth.RequestMeta{})
	var value *Error
	if !errors.As(err, &value) || value.Code != CodeFileNotFound || value.StatusCode != 400 {
		t.Fatalf("logical missing error = %#v, want file.not_found/400", err)
	}
}

func TestOpenAttachmentContentNeverFallsBackOnNonMissingErrors(t *testing.T) {
	content := []byte("canonical")
	record := legacyReadAttachment(content)
	digest := strings.Repeat("b", 64)
	record.StorageObject = &StorageObjectRecord{
		ID: "wso_provider", SHA256: digest, ObjectKey: "workspace/objects/sha256/bb/" + digest,
		ByteSize: int64(len(content)), CreatedAt: time.Now().UTC(),
	}
	repo := newFakeFileRepo()
	repo.state.attachments[record.ID] = &record
	legacy := &fileLegacyReaderStub{responses: map[string]fileLegacyResponse{
		record.StorageKey: legacyReadResponse([]byte("legacy")),
	}}
	store := &fileReadBlobStore{openErr: errors.New("provider outage")}
	service := testService(t, repo, store)
	service.legacyReader = legacy
	if _, err := service.OpenAttachmentContent(context.Background(), OpenAttachmentInput{ActorID: "usr_owner", AttachmentID: record.ID, MaxBytes: 32}); errorCode(err) != CodeInternal {
		t.Fatalf("provider error code = %q, err = %v", errorCode(err), err)
	}
	if len(legacy.calls) != 0 {
		t.Fatalf("provider error fell back to legacy: %v", legacy.calls)
	}

	store.openErr = &platformstorage.Error{Code: "file.storage_mismatch", Message: "mismatch", StatusCode: 500}
	if _, err := service.OpenAttachmentContent(context.Background(), OpenAttachmentInput{ActorID: "usr_owner", AttachmentID: record.ID, MaxBytes: 32}); errorCode(err) != CodeFileStorageMismatch {
		t.Fatalf("canonical mismatch code = %q, err = %v", errorCode(err), err)
	}
	if len(legacy.calls) != 0 {
		t.Fatalf("canonical mismatch fell back to legacy: %v", legacy.calls)
	}

	store.openErr = context.Canceled
	if _, err := service.OpenAttachmentContent(context.Background(), OpenAttachmentInput{ActorID: "usr_owner", AttachmentID: record.ID, MaxBytes: 32}); !errors.Is(err, context.Canceled) {
		t.Fatalf("canonical cancellation = %v", err)
	}
	if len(legacy.calls) != 0 {
		t.Fatalf("canonical cancellation fell back to legacy: %v", legacy.calls)
	}

	// A registry metadata error is not object-not-found and must not be hidden
	// by a readable old object.
	record.StorageObject.ObjectKey = "workspace/objects/sha256/cc/" + digest
	repo.state.attachments[record.ID] = &record
	store.openErr = nil
	store.openCalls = 0
	if _, err := service.OpenAttachmentContent(context.Background(), OpenAttachmentInput{ActorID: "usr_owner", AttachmentID: record.ID, MaxBytes: 32}); errorCode(err) != CodeFileStorageMismatch {
		t.Fatalf("canonical registry mismatch code = %q, err = %v", errorCode(err), err)
	}
	if store.openCalls != 0 || len(legacy.calls) != 0 {
		t.Fatalf("registry mismatch crossed fallback boundary: store=%d legacy=%v", store.openCalls, legacy.calls)
	}

	// Once the canonical object is genuinely unbound, only an explicit missing
	// result allows trying the next recognized legacy layout.
	record.StorageObject = nil
	record.StorageKey = "workspace/spc_default/attachment-legacy/report.txt"
	repo.state.attachments[record.ID] = &record
	legacy.responses = map[string]fileLegacyResponse{
		record.StorageKey: {err: errors.New("legacy provider outage")},
	}
	legacy.calls = nil
	if _, err := service.OpenAttachmentContent(context.Background(), OpenAttachmentInput{ActorID: "usr_owner", AttachmentID: record.ID, MaxBytes: 32}); errorCode(err) != CodeInternal {
		t.Fatalf("legacy provider error code = %q, err = %v", errorCode(err), err)
	}
	if len(legacy.calls) != 1 {
		t.Fatalf("legacy provider error tried alternate key: %v", legacy.calls)
	}

	record.StorageKey = "workspace/uploads/not-a-legacy-object/content"
	repo.state.attachments[record.ID] = &record
	legacy.calls = nil
	if _, err := service.OpenAttachmentContent(context.Background(), OpenAttachmentInput{ActorID: "usr_owner", AttachmentID: record.ID, MaxBytes: 32}); errorCode(err) != CodeFileStorageMissing {
		t.Fatalf("foreign storage key code = %q, err = %v", errorCode(err), err)
	}
	if len(legacy.calls) != 0 {
		t.Fatalf("foreign storage key reached legacy reader: %v", legacy.calls)
	}
}

func TestOpenAttachmentValidatesLegacyBoundedMetadataAndClosesFailures(t *testing.T) {
	content := []byte("legacy")
	record := legacyReadAttachment(content)
	repo := newFakeFileRepo()
	repo.state.attachments[record.ID] = &record
	legacy := &fileLegacyReaderStub{responses: map[string]fileLegacyResponse{
		record.StorageKey: legacyReadResponse(content),
	}}
	service := testService(t, repo, nil)
	service.legacyReader = legacy

	legacy.responses[record.StorageKey] = fileLegacyResponse{
		content: content, body: true, byteSize: int64(len(content)), hasByteSize: true,
		objectKey: record.StorageKey + "/wrong",
	}
	if _, err := service.OpenAttachmentContent(context.Background(), OpenAttachmentInput{ActorID: "usr_owner", AttachmentID: record.ID, MaxBytes: 32}); errorCode(err) != CodeFileStorageMismatch {
		t.Fatalf("wrong legacy key code = %q, err = %v", errorCode(err), err)
	}
	if len(legacy.bodies) != 1 || !legacy.bodies[0].closed {
		t.Fatalf("wrong legacy key body closed = %#v", legacy.bodies)
	}

	legacy.responses[record.StorageKey] = fileLegacyResponse{
		content: content, body: true, byteSize: int64(len(content)) + 1, hasByteSize: true,
	}
	if _, err := service.OpenAttachmentContent(context.Background(), OpenAttachmentInput{ActorID: "usr_owner", AttachmentID: record.ID, MaxBytes: 32}); errorCode(err) != CodeFileStorageMismatch {
		t.Fatalf("wrong legacy size code = %q, err = %v", errorCode(err), err)
	}
	if len(legacy.bodies) != 2 || !legacy.bodies[1].closed {
		t.Fatalf("wrong legacy size body closed = %#v", legacy.bodies)
	}

	legacy.responses[record.StorageKey] = fileLegacyResponse{content: content}
	if _, err := service.OpenAttachmentContent(context.Background(), OpenAttachmentInput{ActorID: "usr_owner", AttachmentID: record.ID, MaxBytes: 32}); errorCode(err) != CodeFileStorageMismatch {
		t.Fatalf("nil legacy body code = %q, err = %v", errorCode(err), err)
	}

	legacy.responses[record.StorageKey] = legacyReadResponse(content)
	legacy.calls = nil
	if _, err := service.OpenAttachmentContent(context.Background(), OpenAttachmentInput{ActorID: "usr_owner", AttachmentID: record.ID, MaxBytes: int64(len(content) - 1)}); errorCode(err) != CodeFileStorageTooLarge {
		t.Fatalf("read limit code = %q, err = %v", errorCode(err), err)
	}
	if len(legacy.calls) != 0 {
		t.Fatalf("read limit reached legacy reader: %v", legacy.calls)
	}

	legacy.responses[record.StorageKey] = legacyReadResponse(content)
	legacy.responses[record.StorageKey] = fileLegacyResponse{
		content: content, body: true, byteSize: int64(len(content)), hasByteSize: true,
		contentType: "",
	}
	opened, err := service.OpenAttachmentContent(context.Background(), OpenAttachmentInput{ActorID: "usr_owner", AttachmentID: record.ID, MaxBytes: 32})
	if err != nil {
		t.Fatalf("legacy metadata fill: %v", err)
	}
	if opened.ContentType != record.MIMEType {
		t.Fatalf("legacy content type = %q, want %q", opened.ContentType, record.MIMEType)
	}
	_ = opened.Body.Close()
}

func TestOpenDownloadUsesGrantBeforeLegacyRead(t *testing.T) {
	content := []byte("download legacy")
	record := legacyReadAttachment(content)
	repo := newFakeFileRepo()
	repo.state.attachments[record.ID] = &record
	transferID := "download-legacy"
	attachmentID := record.ID
	repo.state.transfers[transferID] = &TransferRecord{
		ID: transferID, SpaceID: DefaultSpaceID, UserID: "usr_owner", Direction: string(TransferDownload),
		ByteSize: int64(len(content)), Status: string(TransferCompleted), AttachmentID: &attachmentID,
		CreatedAt: time.Unix(1700000000, 0).UTC(), CompletedAt: timePtr(time.Unix(1700000000, 0).UTC()),
	}
	legacy := &fileLegacyReaderStub{responses: map[string]fileLegacyResponse{
		record.StorageKey: legacyReadResponse(content),
	}}
	service := testService(t, repo, nil)
	service.legacyReader = legacy

	opened, err := service.OpenDownload(context.Background(), CompletedDownloadInput{
		ActorID: "usr_owner", AttachmentID: record.ID, TransferID: transferID, MaxBytes: int64(len(content)),
	})
	if err != nil {
		t.Fatalf("open granted legacy download: %v", err)
	}
	got, readErr := io.ReadAll(opened.Body)
	_ = opened.Body.Close()
	if readErr != nil || string(got) != string(content) || len(legacy.calls) != 1 {
		t.Fatalf("download bytes=%q err=%v calls=%v", got, readErr, legacy.calls)
	}

	legacy.calls = nil
	if _, err := service.OpenDownload(context.Background(), CompletedDownloadInput{
		ActorID: "usr_owner", AttachmentID: record.ID, TransferID: "wrong-transfer", MaxBytes: 32,
	}); errorCode(err) != CodeDownloadInvalid {
		t.Fatalf("invalid grant code = %q, err = %v", errorCode(err), err)
	}
	if len(legacy.calls) != 0 {
		t.Fatalf("invalid grant reached legacy reader: %v", legacy.calls)
	}
}

func TestLegacyAttachmentKeysMirrorNodeAndRejectCrossSpaceIdentity(t *testing.T) {
	record := legacyReadAttachment([]byte("x"))
	record.FileName = "报告😀.txt"
	record.StorageKey = "workspace/spc_default/attachment-legacy/____.txt"
	keys := legacyAttachmentStorageKeys(record, DefaultSpaceID)
	if len(keys) != 2 || keys[0] != record.StorageKey || keys[1] != "workspace/attachments/spc_default/attachment-legacy/content" {
		t.Fatalf("legacy keys = %v", keys)
	}
	record.SpaceID = "spc_other"
	if keys := legacyAttachmentStorageKeys(record, DefaultSpaceID); len(keys) != 0 {
		t.Fatalf("cross-space legacy keys = %v", keys)
	}
}

func legacyReadAttachment(content []byte) AttachmentRecord {
	return AttachmentRecord{
		ID: "attachment-legacy", SpaceID: DefaultSpaceID, UploaderID: "usr_owner", Visibility: string(VisibilitySpace),
		Status: string(AttachmentAvailable), FileName: "report.txt", MIMEType: "text/plain", ByteSize: int64(len(content)),
		StorageKey: "workspace/spc_default/attachment-legacy/report.txt", CreatedAt: time.Unix(1700000000, 0).UTC(),
		CompletedAt: timePtr(time.Unix(1700000000, 0).UTC()),
	}
}

func testSHA256(content []byte) string {
	digest := sha256.Sum256(content)
	return hex.EncodeToString(digest[:])
}
