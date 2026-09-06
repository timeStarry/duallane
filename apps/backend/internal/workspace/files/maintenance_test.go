package files

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

type maintenanceFileRepo struct {
	*fakeFileRepo
	records []StaleUploadRecord
	onPage  func()
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
