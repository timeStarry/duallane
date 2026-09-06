package files

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

type maintenanceFileRepo struct {
	*fakeFileRepo
	records   []StaleUploadRecord
	onPage    func()
	onTx      func()
	seenAfter []*UploadMaintenanceCursor
}

func (r *maintenanceFileRepo) WithTx(ctx context.Context, fn func(Tx) error) error {
	err := r.fakeFileRepo.WithTx(ctx, fn)
	if err == nil && r.onTx != nil {
		r.onTx()
	}
	return err
}

func TestMaintenanceCancellationPreventsNewStorageOperations(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	calls := 0
	operation := func() error { calls++; return nil }
	if err := retryMaintenance(ctx, 2, operation); !errors.Is(err, context.Canceled) {
		t.Fatalf("retry error=%v", err)
	}
	if err := withMaintenanceObjectTimeoutErr(ctx, time.Second, func(context.Context) error { return operation() }); !errors.Is(err, context.Canceled) {
		t.Fatalf("object error=%v", err)
	}
	if calls != 0 {
		t.Fatalf("started %d storage operations after cancellation", calls)
	}
}

func (r *maintenanceFileRepo) ListUploadMaintenancePage(_ context.Context, _ string, before time.Time, after *UploadMaintenanceCursor, limit int, includeTerminal bool) (UploadMaintenancePage, error) {
	r.mu.Lock()
	items := append([]StaleUploadRecord(nil), r.records...)
	r.mu.Unlock()
	r.mu.Lock()
	r.seenAfter = append(r.seenAfter, cloneUploadMaintenanceCursor(after))
	r.mu.Unlock()
	if r.onPage != nil {
		r.onPage()
	}
	filtered := make([]StaleUploadRecord, 0, len(items))
	for _, item := range items {
		if !includeTerminal && (item.Transfer.Status != string(TransferReserved) || item.Attachment.Status != string(AttachmentPending)) {
			continue
		}
		if !transferActivity(item.Transfer).Before(before) || !maintenanceRecordAfter(item, after) {
			continue
		}
		filtered = append(filtered, item)
	}
	sortMaintenanceRecords(filtered)
	page := UploadMaintenancePage{Records: filtered}
	if len(page.Records) > limit {
		page.Records = page.Records[:limit]
		page.Next = maintenanceCursorFor(page.Records[len(page.Records)-1])
	}
	return page, nil
}

func sortMaintenanceRecords(records []StaleUploadRecord) {
	for left := 0; left < len(records); left++ {
		for right := left + 1; right < len(records); right++ {
			if maintenanceRecordLess(records[right], records[left]) {
				records[left], records[right] = records[right], records[left]
			}
		}
	}
}

func maintenanceTestTransfer(status, uploadID string, at time.Time) (TransferRecord, AttachmentRecord, StaleUploadRecord) {
	attachmentID := "att_maintenance_" + uploadID
	transferTime := at
	transfer := TransferRecord{ID: uploadID, SpaceID: DefaultSpaceID, UserID: "usr_file_owner", Direction: string(TransferUpload), ByteSize: 7, Status: status, AttachmentID: &attachmentID, CreatedAt: at, LastActivityAt: &transferTime}
	attachmentStatus := string(AttachmentPending)
	if status != string(TransferReserved) {
		attachmentStatus = string(AttachmentAvailable)
	}
	attachment := AttachmentRecord{ID: attachmentID, SpaceID: DefaultSpaceID, UploaderID: "usr_file_owner", Status: attachmentStatus, FileName: "maintenance.txt", MIMEType: "text/plain", ByteSize: 7, StorageKey: stagingContentKey(uploadID), UploadTransferID: uploadID, CreatedAt: at}
	return transfer, attachment, StaleUploadRecord{Transfer: transfer, Attachment: attachment}
}

func TestRunUploadMaintenanceRechecksFreshReservationAfterCandidateRead(t *testing.T) {
	base := newFakeFileRepo()
	at := time.Date(2026, 9, 6, 10, 0, 0, 0, time.UTC)
	transfer, attachment, record := maintenanceTestTransfer(string(TransferReserved), "upload-touch-wins", at.Add(-time.Hour))
	base.state.transfers[transfer.ID] = &transfer
	base.state.attachments[attachment.ID] = &attachment
	repo := &maintenanceFileRepo{fakeFileRepo: base, records: []StaleUploadRecord{record}}
	repo.onPage = func() {
		repo.mu.Lock()
		fresh := at
		repo.state.transfers[transfer.ID].LastActivityAt = &fresh
		repo.mu.Unlock()
	}
	service := NewService(ServiceOptions{Repository: repo, SpaceID: DefaultSpaceID, Now: func() time.Time { return at }})
	result, err := service.RunUploadMaintenance(context.Background(), UploadMaintenanceOptions{Now: at, IncludeTerminalArtifacts: false})
	if err != nil {
		t.Fatalf("maintenance: %v", err)
	}
	if result.StaleReservationsFailed != 0 {
		t.Fatalf("fresh reservation was failed: %#v", result)
	}
	current := base.state.transfers[transfer.ID]
	if current.Status != string(TransferReserved) || current.LastActivityAt == nil || !current.LastActivityAt.Equal(at) {
		t.Fatalf("fresh transfer = %#v", current)
	}
}

func TestRunUploadMaintenanceWritesEvidenceAndCleansTerminalArtifacts(t *testing.T) {
	root := t.TempDir()
	store, err := platformstorage.NewLocalBlobStore(root)
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	base := newFakeFileRepo()
	transfer, attachment, record := maintenanceTestTransfer(string(TransferReserved), "upload-fail-maint", at.Add(-time.Hour))
	base.state.transfers[transfer.ID] = &transfer
	base.state.attachments[attachment.ID] = &attachment
	base.state.parts[transfer.ID] = map[int]*UploadPartRecord{1: {UploadID: transfer.ID, PartNumber: 1, ByteSize: 7, SHA256: strings.Repeat("a", 64), CreatedAt: at.Add(-time.Hour), UpdatedAt: at.Add(-time.Hour)}}
	repo := &maintenanceFileRepo{fakeFileRepo: base, records: []StaleUploadRecord{record}}
	for _, key := range []string{stagingContentKey(transfer.ID), stagingPartKey(transfer.ID, 1), "workspace/uploads/upload-fail-maint/attempts/00000000-0000-0000-0000-000000000001"} {
		if _, err := store.Put(context.Background(), key, strings.NewReader("attempt"), int64(len("attempt")), ""); err != nil {
			t.Fatalf("put maintenance object: %v", err)
		}
		old := at.Add(-time.Hour)
		if err := os.Chtimes(filepath.Join(root, filepath.FromSlash(key)), old, old); err != nil {
			t.Fatal(err)
		}
	}
	service := NewService(ServiceOptions{Repository: repo, BlobStore: store, SpaceID: DefaultSpaceID, Now: func() time.Time { return at }})
	result, err := service.RunUploadMaintenance(context.Background(), UploadMaintenanceOptions{Now: at, IncludeTerminalArtifacts: false})
	if err != nil {
		t.Fatalf("maintenance: %v", err)
	}
	if result.StaleReservationsFailed != 1 || len(base.state.events) != 1 || len(base.state.audits) != 1 {
		t.Fatalf("maintenance evidence/result = %#v events=%d audits=%d", result, len(base.state.events), len(base.state.audits))
	}
	var payload map[string]any
	if err := json.Unmarshal(base.state.events[0].PayloadJSON, &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload) != 2 || payload["attachmentId"] != attachment.ID || payload["status"] != string(AttachmentFailed) {
		t.Fatalf("non-content-free event payload: %#v", payload)
	}
	if base.state.transfers[transfer.ID].Status != string(TransferFailed) || base.state.attachments[attachment.ID].Status != string(AttachmentFailed) {
		t.Fatalf("failed state not persisted: transfer=%#v attachment=%#v", base.state.transfers[transfer.ID], base.state.attachments[attachment.ID])
	}
	if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(stagingContentKey(transfer.ID)))); !os.IsNotExist(err) {
		t.Fatalf("staging content remains, err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(root, filepath.FromSlash("workspace/uploads/upload-fail-maint/attempts/00000000-0000-0000-0000-000000000001"))); !os.IsNotExist(err) {
		t.Fatalf("attempt remains, err=%v", err)
	}
}

func TestRunUploadMaintenanceDeletesOnlyOldAttemptsForTerminalUpload(t *testing.T) {
	root := t.TempDir()
	store, err := platformstorage.NewLocalBlobStore(root)
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	base := newFakeFileRepo()
	transfer, attachment, record := maintenanceTestTransfer(string(TransferCompleted), "upload-terminal-maint", at.Add(-time.Hour))
	base.state.transfers[transfer.ID] = &transfer
	base.state.attachments[attachment.ID] = &attachment
	repo := &maintenanceFileRepo{fakeFileRepo: base, records: []StaleUploadRecord{record}}
	oldKey := "workspace/uploads/upload-terminal-maint/attempts/00000000-0000-0000-0000-000000000001"
	freshKey := "workspace/uploads/upload-terminal-maint/attempts/00000000-0000-0000-0000-000000000002"
	for _, key := range []string{stagingContentKey(transfer.ID), oldKey, freshKey} {
		if _, err := store.Put(context.Background(), key, strings.NewReader("attempt"), int64(len("attempt")), ""); err != nil {
			t.Fatalf("put terminal object: %v", err)
		}
	}
	old := at.Add(-time.Hour)
	fresh := at.Add(time.Minute)
	if err := os.Chtimes(filepath.Join(root, filepath.FromSlash(oldKey)), old, old); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(filepath.Join(root, filepath.FromSlash(freshKey)), fresh, fresh); err != nil {
		t.Fatal(err)
	}
	service := NewService(ServiceOptions{Repository: repo, BlobStore: store, SpaceID: DefaultSpaceID, Now: func() time.Time { return at }})
	result, err := service.RunUploadMaintenance(context.Background(), UploadMaintenanceOptions{Now: at, IncludeTerminalArtifacts: true})
	if err != nil {
		t.Fatalf("terminal maintenance: %v", err)
	}
	if result.TerminalUploadsInspected != 1 {
		t.Fatalf("terminal result = %#v", result)
	}
	if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(oldKey))); !os.IsNotExist(err) {
		t.Fatalf("old terminal attempt remains, err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(freshKey))); err != nil {
		t.Fatalf("fresh terminal attempt was deleted: %v", err)
	}
}

func TestRunUploadMaintenanceRetainsKeysetAcrossPagesAndWrapsAtEnd(t *testing.T) {
	at := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	base := newFakeFileRepo()
	repo := &maintenanceFileRepo{fakeFileRepo: base}
	for index := 0; index < 5; index++ {
		id := fmt.Sprintf("upload-page-%02d", index)
		transfer, attachment, record := maintenanceTestTransfer(string(TransferCompleted), id, at.Add(-2*time.Hour-time.Duration(index)*time.Minute))
		base.state.transfers[id] = &transfer
		base.state.attachments[attachment.ID] = &attachment
		repo.records = append(repo.records, record)
	}
	service := NewService(ServiceOptions{Repository: repo, SpaceID: DefaultSpaceID, Now: func() time.Time { return at }})

	var cursor *UploadMaintenanceCursor
	for cycle := 0; cycle < 4; cycle++ {
		result, err := service.RunUploadMaintenance(context.Background(), UploadMaintenanceOptions{
			Now: at, BatchSize: 2, IncludeTerminalArtifacts: true, Cursor: cursor,
		})
		if err != nil {
			t.Fatalf("cycle %d maintenance: %v", cycle, err)
		}
		wantScanned := 2
		if cycle == 2 {
			wantScanned = 1
		}
		if result.Scanned != wantScanned {
			t.Fatalf("cycle %d scanned=%d want=%d result=%#v", cycle, result.Scanned, wantScanned, result)
		}
		cursor = result.Next
	}
	if len(repo.seenAfter) != 4 {
		t.Fatalf("page cursors=%#v", repo.seenAfter)
	}
	if repo.seenAfter[0] != nil || repo.seenAfter[3] != nil {
		t.Fatalf("keyset did not wrap only after the third page: %#v", repo.seenAfter)
	}
	var ids []string
	for _, cursor := range repo.seenAfter {
		if cursor != nil {
			ids = append(ids, cursor.ID)
		} else {
			ids = append(ids, "<wrap>")
		}
	}
	if repo.seenAfter[1] == nil || repo.seenAfter[1].ID != "upload-page-03" || repo.seenAfter[2] == nil || repo.seenAfter[2].ID != "upload-page-01" {
		t.Fatalf("keyset page sequence=%v", ids)
	}
}

func TestRunUploadMaintenanceDoesNotAdvancePastCancelledCandidate(t *testing.T) {
	at := time.Date(2026, 9, 6, 13, 0, 0, 0, time.UTC)
	base := newFakeFileRepo()
	repo := &maintenanceFileRepo{fakeFileRepo: base}
	for index := 0; index < 2; index++ {
		id := fmt.Sprintf("upload-cancel-%02d", index)
		transfer, attachment, record := maintenanceTestTransfer(string(TransferCompleted), id, at.Add(-time.Hour-time.Duration(index)*time.Minute))
		base.state.transfers[id] = &transfer
		base.state.attachments[attachment.ID] = &attachment
		repo.records = append(repo.records, record)
	}
	ctx, cancel := context.WithCancel(context.Background())
	repo.onTx = cancel
	service := NewService(ServiceOptions{Repository: repo, SpaceID: DefaultSpaceID, Now: func() time.Time { return at }})
	result, err := service.RunUploadMaintenance(ctx, UploadMaintenanceOptions{
		Now: at, BatchSize: 2, IncludeTerminalArtifacts: true,
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("maintenance error=%v", err)
	}
	if result.TerminalUploadsInspected != 1 || result.Next != nil {
		t.Fatalf("cancelled candidate was skipped: result=%#v", result)
	}
	if base.state.transfers["upload-cancel-00"].Status != string(TransferCompleted) {
		t.Fatalf("unexpected terminal state mutation: %#v", base.state.transfers["upload-cancel-00"])
	}
}

func TestRunUploadMaintenanceCancellationBeforePageDoesNotStartRepositoryIO(t *testing.T) {
	base := newFakeFileRepo()
	called := 0
	repo := &maintenanceFileRepo{fakeFileRepo: base, onPage: func() { called++ }}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	service := NewService(ServiceOptions{Repository: repo})
	result, err := service.RunUploadMaintenance(ctx, UploadMaintenanceOptions{})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("maintenance error=%v", err)
	}
	if called != 0 || result.Scanned != 0 {
		t.Fatalf("repository IO started after cancellation: calls=%d result=%#v", called, result)
	}
}

func TestUploadMaintenanceAttemptCursorsAreBounded(t *testing.T) {
	source := make(map[string]string, MaxUploadMaintenanceAttemptCursors+32)
	for index := 0; index < MaxUploadMaintenanceAttemptCursors+32; index++ {
		source[fmt.Sprintf("upload-%04d", index)] = fmt.Sprintf("cursor-%04d", index)
	}
	bounded := cloneAttemptCursors(source)
	if len(bounded) != MaxUploadMaintenanceAttemptCursors {
		t.Fatalf("bounded cursors=%d want=%d", len(bounded), MaxUploadMaintenanceAttemptCursors)
	}
	rememberAttemptCursor(bounded, "upload-new", "cursor-new")
	if len(bounded) != MaxUploadMaintenanceAttemptCursors || bounded["upload-new"] != "cursor-new" {
		t.Fatalf("updated bounded cursors=%d new=%q", len(bounded), bounded["upload-new"])
	}
}

type failingMaintenanceBlobStore struct {
	inner   platformstorage.BlobStore
	failOn  string
	block   bool
	mu      sync.Mutex
	deletes []string
}

func (s *failingMaintenanceBlobStore) Put(ctx context.Context, key string, source io.Reader, expectedSize int64, expectedSHA256 string) (platformstorage.StoredObject, error) {
	return s.inner.Put(ctx, key, source, expectedSize, expectedSHA256)
}

func (s *failingMaintenanceBlobStore) Open(ctx context.Context, object platformstorage.Object, maxBytes int64) (platformstorage.OpenedObject, error) {
	return s.inner.Open(ctx, object, maxBytes)
}

func (s *failingMaintenanceBlobStore) Delete(ctx context.Context, object platformstorage.Object) error {
	s.mu.Lock()
	s.deletes = append(s.deletes, object.Key)
	s.mu.Unlock()
	if s.block {
		<-ctx.Done()
		return ctx.Err()
	}
	if object.Key == s.failOn {
		return errors.New("synthetic storage failure")
	}
	return s.inner.Delete(ctx, object)
}

func TestRunUploadMaintenanceFailureDoesNotStarveLaterRecords(t *testing.T) {
	root := t.TempDir()
	local, err := platformstorage.NewLocalBlobStore(root)
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 9, 6, 14, 0, 0, 0, time.UTC)
	base := newFakeFileRepo()
	repo := &maintenanceFileRepo{fakeFileRepo: base}
	for index := 0; index < 2; index++ {
		id := fmt.Sprintf("upload-failure-%02d", index)
		transfer, attachment, record := maintenanceTestTransfer(string(TransferCompleted), id, at.Add(-time.Hour-time.Duration(index)*time.Minute))
		base.state.transfers[id] = &transfer
		base.state.attachments[attachment.ID] = &attachment
		repo.records = append(repo.records, record)
	}
	store := &failingMaintenanceBlobStore{inner: local, failOn: stagingContentKey("upload-failure-00")}
	service := NewService(ServiceOptions{Repository: repo, BlobStore: store, SpaceID: DefaultSpaceID, Now: func() time.Time { return at }})
	result, err := service.RunUploadMaintenance(context.Background(), UploadMaintenanceOptions{
		Now: at, BatchSize: 2, IncludeTerminalArtifacts: true,
	})
	if err == nil || result.ObjectFailures == 0 {
		t.Fatalf("expected retryable cleanup failure: result=%#v error=%v", result, err)
	}
	store.mu.Lock()
	deletes := append([]string(nil), store.deletes...)
	store.mu.Unlock()
	foundLater := false
	for _, key := range deletes {
		if strings.Contains(key, "upload-failure-01") {
			foundLater = true
			break
		}
	}
	if !foundLater {
		t.Fatalf("later record was starved; deletes=%v", deletes)
	}
	if result.Next != nil {
		t.Fatalf("complete page did not wrap after attempted failures: %#v", result.Next)
	}
}

func TestRunUploadMaintenanceBudgetStopsStartingLaterStorageIO(t *testing.T) {
	root := t.TempDir()
	local, err := platformstorage.NewLocalBlobStore(root)
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 9, 6, 14, 30, 0, 0, time.UTC)
	base := newFakeFileRepo()
	repo := &maintenanceFileRepo{fakeFileRepo: base}
	for index := 0; index < 2; index++ {
		id := fmt.Sprintf("upload-budget-%02d", index)
		transfer, attachment, record := maintenanceTestTransfer(string(TransferCompleted), id, at.Add(-time.Hour-time.Duration(index)*time.Minute))
		base.state.transfers[id] = &transfer
		base.state.attachments[attachment.ID] = &attachment
		repo.records = append(repo.records, record)
	}
	store := &failingMaintenanceBlobStore{inner: local, block: true}
	service := NewService(ServiceOptions{Repository: repo, BlobStore: store, SpaceID: DefaultSpaceID, Now: func() time.Time { return at }})
	result, err := service.RunUploadMaintenance(context.Background(), UploadMaintenanceOptions{
		Now: at, BatchSize: 2, Timeout: 50 * time.Millisecond, ObjectTimeout: time.Second, IncludeTerminalArtifacts: true,
	})
	if err == nil || result.TerminalUploadsInspected != 1 || result.Next != nil {
		t.Fatalf("budget result=%#v error=%v", result, err)
	}
	store.mu.Lock()
	deleteCalls := len(store.deletes)
	store.mu.Unlock()
	if deleteCalls != 1 {
		t.Fatalf("storage IO started after budget expiry: calls=%d", deleteCalls)
	}
}
