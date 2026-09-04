package files

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type fakeFileState struct {
	actors      map[string]*auth.Actor
	attachments map[string]*AttachmentRecord
	transfers   map[string]*TransferRecord
	parts       map[string]map[int]*UploadPartRecord
	objects     map[string]*StorageObjectRecord
	members     map[string]bool
	participant map[string]bool
	events      []EventInput
	audits      []AuditInput
	locks       []string
	failAudit   bool
	failEvent   bool
}

type fakeFileRepo struct {
	mu    sync.Mutex
	state *fakeFileState
}

type fakeFileTx struct {
	state *fakeFileState
}

func newFakeFileRepo() *fakeFileRepo {
	return &fakeFileRepo{state: &fakeFileState{
		actors:      map[string]*auth.Actor{},
		attachments: map[string]*AttachmentRecord{},
		transfers:   map[string]*TransferRecord{},
		parts:       map[string]map[int]*UploadPartRecord{},
		objects:     map[string]*StorageObjectRecord{},
		members:     map[string]bool{},
		participant: map[string]bool{},
	}}
}

func (r *fakeFileRepo) WithTx(_ context.Context, fn func(Tx) error) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	working := r.state.clone()
	if err := fn(&fakeFileTx{state: working}); err != nil {
		return err
	}
	r.state = working
	return nil
}

func (r *fakeFileRepo) LookupActor(_ context.Context, _, userID string) (*auth.Actor, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return cloneActor(r.state.actors[userID]), nil
}

func (r *fakeFileRepo) GetAttachment(_ context.Context, _, attachmentID string) (*AttachmentRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return cloneAttachment(r.state.attachments[attachmentID]), nil
}

func (r *fakeFileRepo) ListAttachments(_ context.Context, _ AttachmentListQuery) ([]AttachmentRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	items := make([]AttachmentRecord, 0, len(r.state.attachments))
	for _, item := range r.state.attachments {
		if item.Status == string(AttachmentAvailable) {
			items = append(items, *cloneAttachment(item))
		}
	}
	for left := 0; left < len(items); left++ {
		for right := left + 1; right < len(items); right++ {
			if items[right].CreatedAt.After(items[left].CreatedAt) {
				items[left], items[right] = items[right], items[left]
			}
		}
	}
	return items, nil
}

func (r *fakeFileRepo) GetTransfer(_ context.Context, _, userID, transferID string, direction TransferDirection) (*TransferRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	item := r.state.transfers[transferID]
	if item == nil || item.UserID != userID || item.Direction != string(direction) {
		return nil, nil
	}
	copy := *item
	copy.AttachmentID = cloneStringPtr(item.AttachmentID)
	copy.CompletedAt = cloneTimePtr(item.CompletedAt)
	copy.ReleasedAt = cloneTimePtr(item.ReleasedAt)
	copy.LastActivityAt = cloneTimePtr(item.LastActivityAt)
	return &copy, nil
}

func (r *fakeFileRepo) ListUploadParts(_ context.Context, uploadID string) ([]UploadPartRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return cloneParts(r.state.parts[uploadID]), nil
}

func (r *fakeFileRepo) GetUploadPart(_ context.Context, uploadID string, partNumber int) (*UploadPartRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	part := r.state.parts[uploadID][partNumber]
	if part == nil {
		return nil, nil
	}
	copy := *part
	return &copy, nil
}

func (r *fakeFileRepo) UsedTransferBytes(_ context.Context, _, userID string, since time.Time) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return usedFakeTransferBytes(r.state, userID, since), nil
}

func (r *fakeFileRepo) ListStaleUploads(_ context.Context, _ string, _ time.Time) ([]StaleUploadRecord, error) {
	return []StaleUploadRecord{}, nil
}

func (r *fakeFileRepo) ConversationMemberActive(_ context.Context, _, conversationID, userID string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.state.members[conversationID+":"+userID], nil
}

func (r *fakeFileRepo) ParticipantOnlyConversation(_ context.Context, _, conversationID string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.state.participant[conversationID], nil
}

func (r *fakeFileRepo) StorageObject(_ context.Context, objectID string) (*StorageObjectRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return cloneObject(r.state.objects[objectID]), nil
}

func (r *fakeFileRepo) StorageObjectReferenceCount(_ context.Context, objectID string) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return objectReferences(r.state, objectID), nil
}

func (t *fakeFileTx) LookupActor(_ context.Context, _, userID string) (*auth.Actor, error) {
	return cloneActor(t.state.actors[userID]), nil
}

func (t *fakeFileTx) GetAttachment(_ context.Context, _, attachmentID string) (*AttachmentRecord, error) {
	return cloneAttachment(t.state.attachments[attachmentID]), nil
}

func (t *fakeFileTx) ListAttachments(_ context.Context, _ AttachmentListQuery) ([]AttachmentRecord, error) {
	items := make([]AttachmentRecord, 0, len(t.state.attachments))
	for _, item := range t.state.attachments {
		if item.Status == string(AttachmentAvailable) {
			items = append(items, *cloneAttachment(item))
		}
	}
	return items, nil
}

func (t *fakeFileTx) GetTransfer(_ context.Context, _, userID, transferID string, direction TransferDirection) (*TransferRecord, error) {
	item := t.state.transfers[transferID]
	if item == nil || item.UserID != userID || item.Direction != string(direction) {
		return nil, nil
	}
	copy := *item
	copy.AttachmentID = cloneStringPtr(item.AttachmentID)
	copy.CompletedAt = cloneTimePtr(item.CompletedAt)
	copy.ReleasedAt = cloneTimePtr(item.ReleasedAt)
	copy.LastActivityAt = cloneTimePtr(item.LastActivityAt)
	return &copy, nil
}

func (t *fakeFileTx) ListUploadParts(_ context.Context, uploadID string) ([]UploadPartRecord, error) {
	return cloneParts(t.state.parts[uploadID]), nil
}

func (t *fakeFileTx) GetUploadPart(_ context.Context, uploadID string, partNumber int) (*UploadPartRecord, error) {
	part := t.state.parts[uploadID][partNumber]
	if part == nil {
		return nil, nil
	}
	copy := *part
	return &copy, nil
}

func (t *fakeFileTx) UsedTransferBytes(_ context.Context, _, userID string, since time.Time) (int64, error) {
	return usedFakeTransferBytes(t.state, userID, since), nil
}

func (t *fakeFileTx) ListStaleUploads(_ context.Context, _ string, _ time.Time) ([]StaleUploadRecord, error) {
	return []StaleUploadRecord{}, nil
}

func (t *fakeFileTx) ConversationMemberActive(_ context.Context, _, conversationID, userID string) (bool, error) {
	return t.state.members[conversationID+":"+userID], nil
}

func (t *fakeFileTx) ParticipantOnlyConversation(_ context.Context, _, conversationID string) (bool, error) {
	return t.state.participant[conversationID], nil
}

func (t *fakeFileTx) StorageObject(_ context.Context, objectID string) (*StorageObjectRecord, error) {
	return cloneObject(t.state.objects[objectID]), nil
}

func (t *fakeFileTx) StorageObjectReferenceCount(_ context.Context, objectID string) (int64, error) {
	return objectReferences(t.state, objectID), nil
}

func (t *fakeFileTx) Lock(_ context.Context, key string) error {
	t.state.locks = append(t.state.locks, key)
	return nil
}

func (t *fakeFileTx) CreateTransfer(_ context.Context, transfer TransferRecord) error {
	copy := transfer
	copy.AttachmentID = cloneStringPtr(transfer.AttachmentID)
	copy.CompletedAt = cloneTimePtr(transfer.CompletedAt)
	copy.ReleasedAt = cloneTimePtr(transfer.ReleasedAt)
	copy.LastActivityAt = cloneTimePtr(transfer.LastActivityAt)
	t.state.transfers[transfer.ID] = &copy
	return nil
}

func (t *fakeFileTx) CreateAttachment(_ context.Context, attachment AttachmentRecord) error {
	copy := attachment
	copy.ConversationID = cloneStringPtr(attachment.ConversationID)
	copy.CompletedAt = cloneTimePtr(attachment.CompletedAt)
	t.state.attachments[attachment.ID] = &copy
	return nil
}

func (t *fakeFileTx) UpsertUploadPart(_ context.Context, part UploadPartRecord) (bool, error) {
	if t.state.parts[part.UploadID] == nil {
		t.state.parts[part.UploadID] = map[int]*UploadPartRecord{}
	}
	if existing, ok := t.state.parts[part.UploadID][part.PartNumber]; ok {
		if existing.ByteSize != part.ByteSize || !strings.EqualFold(existing.SHA256, part.SHA256) {
			return false, NewError(CodeUploadPartConflict, MessageUploadPartConflict, 409)
		}
		return false, nil
	}
	copy := part
	t.state.parts[part.UploadID][part.PartNumber] = &copy
	return true, nil
}

func (t *fakeFileTx) TouchUpload(_ context.Context, uploadID string, at time.Time) error {
	transfer := t.state.transfers[uploadID]
	if transfer == nil || transfer.Status != string(TransferReserved) {
		return uploadInvalidError()
	}
	transfer.LastActivityAt = cloneTimePtr(&at)
	return nil
}

func (t *fakeFileTx) CompleteUpload(_ context.Context, spaceID, userID, transferID, attachmentID string, at time.Time) (bool, error) {
	transfer := t.state.transfers[transferID]
	attachment := t.state.attachments[attachmentID]
	if transfer == nil || attachment == nil || transfer.SpaceID != spaceID || transfer.UserID != userID || transfer.Status != string(TransferReserved) || attachment.Status != string(AttachmentPending) {
		return false, nil
	}
	transfer.Status = string(TransferCompleted)
	transfer.CompletedAt = cloneTimePtr(&at)
	transfer.LastActivityAt = cloneTimePtr(&at)
	attachment.Status = string(AttachmentAvailable)
	attachment.CompletedAt = cloneTimePtr(&at)
	delete(t.state.parts, transferID)
	return true, nil
}

func (t *fakeFileTx) FailUpload(_ context.Context, spaceID, userID, transferID, attachmentID, _ string, at time.Time) (bool, error) {
	transfer := t.state.transfers[transferID]
	attachment := t.state.attachments[attachmentID]
	if transfer == nil || attachment == nil || transfer.SpaceID != spaceID || transfer.UserID != userID || transfer.Status != string(TransferReserved) || attachment.Status != string(AttachmentPending) {
		return false, nil
	}
	transfer.Status = string(TransferFailed)
	transfer.ReleasedAt = cloneTimePtr(&at)
	transfer.LastActivityAt = cloneTimePtr(&at)
	attachment.Status = string(AttachmentFailed)
	delete(t.state.parts, transferID)
	return true, nil
}

func (t *fakeFileTx) ReleaseDownload(_ context.Context, spaceID, userID, transferID string, at time.Time) (bool, error) {
	transfer := t.state.transfers[transferID]
	if transfer == nil || transfer.SpaceID != spaceID || transfer.UserID != userID || transfer.Direction != string(TransferDownload) || transfer.Status != string(TransferCompleted) {
		return false, nil
	}
	transfer.Status = string(TransferFailed)
	transfer.CompletedAt = nil
	transfer.ReleasedAt = cloneTimePtr(&at)
	return true, nil
}

func (t *fakeFileTx) EnsureStorageObjectAndBind(_ context.Context, spaceID, attachmentID string, object StorageObjectRecord) (*StorageObjectRecord, bool, error) {
	attachment := t.state.attachments[attachmentID]
	if attachment == nil || attachment.SpaceID != spaceID {
		return nil, false, fileNotFoundError()
	}
	var previous *StorageObjectRecord
	if attachment.StorageObjectID != "" {
		previous = cloneObject(t.state.objects[attachment.StorageObjectID])
	}
	_, existed := t.state.objects[object.ID]
	copy := object
	t.state.objects[object.ID] = &copy
	attachment.StorageObjectID = object.ID
	attachment.StorageObject = cloneObject(&object)
	return previous, !existed, nil
}

func (t *fakeFileTx) DetachAttachment(_ context.Context, spaceID, attachmentID, _ string, _ time.Time) (*StorageObjectRecord, bool, error) {
	attachment := t.state.attachments[attachmentID]
	if attachment == nil || attachment.SpaceID != spaceID || attachment.Status == string(AttachmentRemoved) {
		return nil, false, nil
	}
	previous := cloneObject(t.state.objects[attachment.StorageObjectID])
	attachment.Status = string(AttachmentRemoved)
	attachment.StorageObjectID = ""
	attachment.StorageObject = nil
	return previous, true, nil
}

func (t *fakeFileTx) CleanupStorageObject(_ context.Context, objectID string, fallback StorageObjectRecord, at time.Time) (StorageCleanup, error) {
	object := t.state.objects[objectID]
	if object == nil {
		return StorageCleanup{Object: &fallback, DeleteObject: true}, nil
	}
	refs := objectReferences(t.state, objectID)
	if refs > 0 {
		return StorageCleanup{Object: cloneObject(object), References: refs}, nil
	}
	object.DeletedAt = cloneTimePtr(&at)
	return StorageCleanup{Object: cloneObject(object), DeleteObject: true}, nil
}

func (t *fakeFileTx) WriteEvent(_ context.Context, input EventInput) error {
	if t.state.failEvent {
		return errors.New("event write failed")
	}
	t.state.events = append(t.state.events, input)
	return nil
}

func (t *fakeFileTx) WriteAudit(_ context.Context, input AuditInput) error {
	if t.state.failAudit {
		return errors.New("audit write failed")
	}
	t.state.audits = append(t.state.audits, input)
	return nil
}

func (s *fakeFileState) clone() *fakeFileState {
	copy := &fakeFileState{
		actors:      map[string]*auth.Actor{},
		attachments: map[string]*AttachmentRecord{},
		transfers:   map[string]*TransferRecord{},
		parts:       map[string]map[int]*UploadPartRecord{},
		objects:     map[string]*StorageObjectRecord{},
		members:     map[string]bool{},
		participant: map[string]bool{},
		events:      append([]EventInput(nil), s.events...),
		audits:      append([]AuditInput(nil), s.audits...),
		locks:       append([]string(nil), s.locks...),
		failAudit:   s.failAudit,
		failEvent:   s.failEvent,
	}
	for id, actor := range s.actors {
		copy.actors[id] = cloneActor(actor)
	}
	for id, attachment := range s.attachments {
		copy.attachments[id] = cloneAttachment(attachment)
	}
	for id, transfer := range s.transfers {
		value := *transfer
		value.AttachmentID = cloneStringPtr(transfer.AttachmentID)
		value.CompletedAt = cloneTimePtr(transfer.CompletedAt)
		value.ReleasedAt = cloneTimePtr(transfer.ReleasedAt)
		value.LastActivityAt = cloneTimePtr(transfer.LastActivityAt)
		copy.transfers[id] = &value
	}
	for uploadID, parts := range s.parts {
		copy.parts[uploadID] = map[int]*UploadPartRecord{}
		for number, part := range parts {
			value := *part
			copy.parts[uploadID][number] = &value
		}
	}
	for id, object := range s.objects {
		copy.objects[id] = cloneObject(object)
	}
	for key, value := range s.members {
		copy.members[key] = value
	}
	for key, value := range s.participant {
		copy.participant[key] = value
	}
	return copy
}

func cloneActor(value *auth.Actor) *auth.Actor {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneAttachment(value *AttachmentRecord) *AttachmentRecord {
	if value == nil {
		return nil
	}
	copy := *value
	copy.ConversationID = cloneStringPtr(value.ConversationID)
	copy.CompletedAt = cloneTimePtr(value.CompletedAt)
	copy.StorageObject = cloneObject(value.StorageObject)
	return &copy
}

func cloneObject(value *StorageObjectRecord) *StorageObjectRecord {
	if value == nil {
		return nil
	}
	copy := *value
	copy.VerifiedAt = cloneTimePtr(value.VerifiedAt)
	copy.DeletedAt = cloneTimePtr(value.DeletedAt)
	return &copy
}

func cloneTimePtr(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneParts(value map[int]*UploadPartRecord) []UploadPartRecord {
	items := make([]UploadPartRecord, 0, len(value))
	for _, part := range value {
		items = append(items, *part)
	}
	return items
}

func usedFakeTransferBytes(state *fakeFileState, userID string, since time.Time) int64 {
	var used int64
	for _, transfer := range state.transfers {
		if transfer.UserID == userID && transfer.CreatedAt.After(since.Add(-time.Nanosecond)) && (transfer.Status == string(TransferReserved) || transfer.Status == string(TransferCompleted)) {
			used += transfer.ByteSize
		}
	}
	return used
}

func objectReferences(state *fakeFileState, objectID string) int64 {
	var count int64
	for _, attachment := range state.attachments {
		if attachment.StorageObjectID == objectID {
			count++
		}
	}
	return count
}

func testFileIDFactory() IDFactory {
	var sequence int
	return func() (string, error) {
		sequence++
		return "id-" + string(rune('a'+sequence)), nil
	}
}

func testActor() *auth.Actor {
	return &auth.Actor{ID: "usr_owner", GitHubLogin: "owner", DisplayName: "Owner", Kind: "human", Role: "owner"}
}

func testService(t *testing.T, repo *fakeFileRepo, store platformstorage.BlobStore) *Service {
	t.Helper()
	repo.state.actors["usr_owner"] = testActor()
	return NewService(ServiceOptions{Repository: repo, BlobStore: store, SpaceID: "spc_default", Now: func() time.Time { return time.Unix(1700000000, 0).UTC() }, IDFactory: testFileIDFactory()})
}

func errorCode(err error) string {
	var value *Error
	if errors.As(err, &value) {
		return value.Code
	}
	return ""
}

func TestReserveUploadQuotaRejectsBeforeBytesAndAudits(t *testing.T) {
	repo := newFakeFileRepo()
	service := testService(t, repo, nil)
	service.dailyQuotaBytes = 4
	result, err := service.ReserveUpload(context.Background(), ReserveUploadInput{ActorID: "usr_owner", FileName: "secret.txt", ByteSize: 5, Visibility: string(VisibilitySpace)})
	if err != nil || result.Status != string(TransferRejected) {
		t.Fatalf("reserve rejection = %#v, err = %v", result, err)
	}
	if result.ID != "" || len(repo.state.attachments) != 0 || len(repo.state.transfers) != 1 || len(repo.state.events) != 1 || len(repo.state.audits) != 1 {
		t.Fatalf("quota rejection state = result %#v attachments=%d transfers=%d events=%d audits=%d", result, len(repo.state.attachments), len(repo.state.transfers), len(repo.state.events), len(repo.state.audits))
	}
	if repo.state.transfers["id-b"].Status != string(TransferRejected) {
		t.Fatalf("rejected transfer = %#v", repo.state.transfers["id-b"])
	}
}

func TestGetQuotaRechecksActiveActorAndReportsCurrentDayUsage(t *testing.T) {
	repo := newFakeFileRepo()
	service := testService(t, repo, nil)
	service.dailyQuotaBytes = 10
	now := service.nowUTC()
	repo.state.transfers["completed-upload"] = &TransferRecord{
		ID: "completed-upload", SpaceID: DefaultSpaceID, UserID: "usr_owner",
		Direction: string(TransferUpload), ByteSize: 3, Status: string(TransferCompleted), CreatedAt: now,
	}
	snapshot, err := service.GetQuota(context.Background(), "usr_owner")
	if err != nil {
		t.Fatalf("get quota: %v", err)
	}
	if snapshot.UsedToday != 3 || snapshot.RemainingBytes != 7 || snapshot.DailyQuotaBytes != 10 {
		t.Fatalf("quota snapshot = %#v", snapshot)
	}
	delete(repo.state.actors, "usr_owner")
	if _, err := service.GetQuota(context.Background(), "usr_owner"); errorCode(err) != CodeAuthRequired {
		t.Fatalf("inactive actor error code = %q, err = %v", errorCode(err), err)
	}
}

func TestDefaultIDFactoryFailsClosed(t *testing.T) {
	repo := newFakeFileRepo()
	service := NewService(ServiceOptions{Repository: repo, IDFactory: func() (string, error) { return "", errors.New("random source unavailable") }})
	repo.state.actors["usr_owner"] = testActor()
	_, err := service.ReserveUpload(context.Background(), ReserveUploadInput{ActorID: "usr_owner", FileName: "file.txt", ByteSize: 1, Visibility: string(VisibilitySpace)})
	if errorCode(err) != CodeInternal {
		t.Fatalf("id factory error code = %q, err = %v", errorCode(err), err)
	}
	if len(repo.state.attachments) != 0 || len(repo.state.transfers) != 0 {
		t.Fatalf("failed id generation mutated state: %#v", repo.state)
	}
}

func TestUploadDownloadRemovalReusesAndCleansCASObject(t *testing.T) {
	store, err := platformstorage.NewLocalBlobStore(t.TempDir())
	if err != nil {
		t.Fatalf("new blob store: %v", err)
	}
	repo := newFakeFileRepo()
	service := testService(t, repo, store)
	first, err := service.ReserveUpload(context.Background(), ReserveUploadInput{ActorID: "usr_owner", FileName: "report.txt", ByteSize: 7, Visibility: string(VisibilitySpace)})
	if err != nil {
		t.Fatalf("reserve first: %v", err)
	}
	if _, err := service.UploadContent(context.Background(), "usr_owner", first.ID, strings.NewReader("content"), auth.RequestMeta{}); err != nil {
		t.Fatalf("complete first: %v", err)
	}
	second, err := service.ReserveUpload(context.Background(), ReserveUploadInput{ActorID: "usr_owner", FileName: "copy.txt", ByteSize: 7, Visibility: string(VisibilitySpace)})
	if err != nil {
		t.Fatalf("reserve second: %v", err)
	}
	if _, err := service.UploadContent(context.Background(), "usr_owner", second.ID, strings.NewReader("content"), auth.RequestMeta{}); err != nil {
		t.Fatalf("complete second: %v", err)
	}
	firstAttachment := repo.state.attachments[*repo.state.transfers[first.ID].AttachmentID]
	secondAttachment := repo.state.attachments[*repo.state.transfers[second.ID].AttachmentID]
	if firstAttachment.StorageObjectID == "" || firstAttachment.StorageObjectID != secondAttachment.StorageObjectID {
		t.Fatalf("CAS object ids = %q and %q", firstAttachment.StorageObjectID, secondAttachment.StorageObjectID)
	}
	object := repo.state.objects[firstAttachment.StorageObjectID]
	if object == nil || object.DeletedAt != nil {
		t.Fatalf("CAS object registry = %#v", object)
	}

	download, err := service.ReserveDownload(context.Background(), ReserveDownloadInput{ActorID: "usr_owner", AttachmentID: firstAttachment.ID})
	if err != nil {
		t.Fatalf("reserve download: %v", err)
	}
	opened, err := service.OpenDownload(context.Background(), CompletedDownloadInput{ActorID: "usr_owner", AttachmentID: firstAttachment.ID, TransferID: download.ID, MaxBytes: 7})
	if err != nil {
		t.Fatalf("open download: %v", err)
	}
	got, err := io.ReadAll(opened.Body)
	_ = opened.Body.Close()
	if err != nil || string(got) != "content" {
		t.Fatalf("download bytes = %q, err = %v", got, err)
	}
	if _, err := service.RemoveAttachment(context.Background(), RemoveAttachmentInput{ActorID: "usr_owner", AttachmentID: firstAttachment.ID}); err != nil {
		t.Fatalf("remove first: %v", err)
	}
	if repo.state.objects[firstAttachment.StorageObjectID].DeletedAt != nil {
		t.Fatal("shared object deleted while second attachment references it")
	}
	if _, err := service.RemoveAttachment(context.Background(), RemoveAttachmentInput{ActorID: "usr_owner", AttachmentID: secondAttachment.ID}); err != nil {
		t.Fatalf("remove second: %v", err)
	}
	removedObject := repo.state.objects[firstAttachment.StorageObjectID]
	if removedObject == nil || removedObject.DeletedAt == nil {
		t.Fatalf("CAS object was not tombstoned: %#v", removedObject)
	}
}

func TestUploadPartRetryAndConflict(t *testing.T) {
	store, err := platformstorage.NewLocalBlobStore(t.TempDir())
	if err != nil {
		t.Fatalf("new blob store: %v", err)
	}
	repo := newFakeFileRepo()
	service := testService(t, repo, store)
	size := UploadPartSize + 1
	reserved, err := service.ReserveUpload(context.Background(), ReserveUploadInput{ActorID: "usr_owner", FileName: "large.bin", ByteSize: size, Visibility: string(VisibilitySpace)})
	if err != nil {
		t.Fatalf("reserve chunk upload: %v", err)
	}
	part := strings.Repeat("a", int(UploadPartSize))
	digestBytes := sha256.Sum256([]byte(part))
	digest := hex.EncodeToString(digestBytes[:])
	result, err := service.UploadPart(context.Background(), UploadPartInput{ActorID: "usr_owner", UploadID: reserved.ID, PartNumber: 1, Content: strings.NewReader(part), ContentLength: UploadPartSize, SHA256: digest})
	if err != nil || result.Reused {
		t.Fatalf("first part = %#v, err = %v", result, err)
	}
	retry, err := service.UploadPart(context.Background(), UploadPartInput{ActorID: "usr_owner", UploadID: reserved.ID, PartNumber: 1, Content: strings.NewReader(part), ContentLength: UploadPartSize, SHA256: digest})
	if err != nil || !retry.Reused {
		t.Fatalf("retry part = %#v, err = %v", retry, err)
	}
	other := strings.Repeat("b", int(UploadPartSize))
	otherDigestBytes := sha256.Sum256([]byte(other))
	otherDigest := hex.EncodeToString(otherDigestBytes[:])
	_, err = service.UploadPart(context.Background(), UploadPartInput{ActorID: "usr_owner", UploadID: reserved.ID, PartNumber: 1, Content: strings.NewReader(other), ContentLength: UploadPartSize, SHA256: otherDigest})
	if errorCode(err) != CodeUploadPartConflict {
		t.Fatalf("conflicting part error code = %q, err = %v", errorCode(err), err)
	}
}

func TestUploadContentMismatchFailsAndReleasesReservation(t *testing.T) {
	store, err := platformstorage.NewLocalBlobStore(t.TempDir())
	if err != nil {
		t.Fatalf("new blob store: %v", err)
	}
	repo := newFakeFileRepo()
	service := testService(t, repo, store)
	reserved, err := service.ReserveUpload(context.Background(), ReserveUploadInput{ActorID: "usr_owner", FileName: "mismatch.bin", ByteSize: 5, Visibility: string(VisibilitySpace)})
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	_, err = service.UploadContent(context.Background(), "usr_owner", reserved.ID, strings.NewReader("x"), auth.RequestMeta{})
	if errorCode(err) != CodeUploadSizeMismatch {
		t.Fatalf("mismatch error code = %q, err = %v", errorCode(err), err)
	}
	transfer := repo.state.transfers[reserved.ID]
	attachment := repo.state.attachments[*transfer.AttachmentID]
	if transfer.Status != string(TransferFailed) || attachment.Status != string(AttachmentFailed) {
		t.Fatalf("mismatch state transfer=%#v attachment=%#v", transfer, attachment)
	}
	used, err := repo.UsedTransferBytes(context.Background(), DefaultSpaceID, "usr_owner", time.Unix(0, 0).UTC())
	if err != nil || used != 0 {
		t.Fatalf("released quota used=%d err=%v", used, err)
	}
}

func TestAuditFailureRollsBackReserve(t *testing.T) {
	repo := newFakeFileRepo()
	repo.state.failAudit = true
	service := testService(t, repo, nil)
	_, err := service.ReserveUpload(context.Background(), ReserveUploadInput{ActorID: "usr_owner", FileName: "file.txt", ByteSize: 1, Visibility: string(VisibilitySpace)})
	if errorCode(err) != CodeInternal {
		t.Fatalf("audit failure code = %q, err = %v", errorCode(err), err)
	}
	if len(repo.state.attachments) != 0 || len(repo.state.transfers) != 0 || len(repo.state.events) != 0 || len(repo.state.audits) != 0 {
		t.Fatalf("audit failure committed state: %#v", repo.state)
	}
}

func TestPublicAttachmentJSONHasStableNullsAndNoStorageFields(t *testing.T) {
	attachment := projectAttachment(AttachmentRecord{ID: "att-1", SpaceID: DefaultSpaceID, UploaderID: "usr_owner", UploaderName: "Owner", Visibility: string(VisibilitySpace), Status: string(AttachmentAvailable), FileName: "file.txt", MIMEType: "text/plain", ByteSize: 1, CreatedAt: time.Unix(1700000000, 0).UTC()}, testActor())
	encoded, err := json.Marshal(attachment)
	if err != nil {
		t.Fatalf("marshal attachment: %v", err)
	}
	text := string(encoded)
	for _, field := range []string{"\"conversationId\":null", "\"completedAt\":null", "\"availableAt\":null", "\"capabilities\""} {
		if !strings.Contains(text, field) {
			t.Errorf("JSON %s missing in %s", field, text)
		}
	}
	if strings.Contains(text, "storageKey") || strings.Contains(text, "sha256") || strings.Contains(text, "storageObject") {
		t.Fatalf("public attachment leaked storage fields: %s", text)
	}
}
