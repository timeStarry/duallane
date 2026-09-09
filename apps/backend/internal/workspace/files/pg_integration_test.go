//go:build postgres_integration

package files

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	platformmigrations "github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

func TestPGFilesServiceUsesIsolatedSchemaAndAtomicStorageLifecycle(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })

	schema := fmt.Sprintf("duallane_files_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = conn.Exec(cleanupCtx, "DROP SCHEMA IF EXISTS "+identifier+" CASCADE")
	})
	if _, err := conn.Exec(ctx, "SET search_path TO "+identifier); err != nil {
		t.Fatal(err)
	}
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	migrationDirectory := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../web/server/migrations"))
	if _, err := (platformmigrations.Runner{
		Beginner:  platformpostgres.NewMigrationBeginner(conn),
		Directory: migrationDirectory,
	}).Run(ctx); err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 9, 4, 12, 34, 56, 789000000, time.UTC)
	seedPGFilesData(t, ctx, conn, now)
	poolConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	poolConfig.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	var sequence atomic.Int64
	idFactory := func() (string, error) {
		return fmt.Sprintf("file-integration-%03d", sequence.Add(1)), nil
	}
	repository := NewPGRepository(pool, idFactory)
	root := t.TempDir()
	store, err := platformstorage.NewLocalBlobStore(root)
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(ServiceOptions{
		Repository: repository,
		BlobStore:  store,
		SpaceID:    DefaultSpaceID,
		Now:        func() time.Time { return now },
		IDFactory:  idFactory,
	})

	reserved, err := service.ReserveUpload(ctx, ReserveUploadInput{
		ActorID: "usr_file_owner", FileName: "report.txt", MIMEType: "text/plain", ByteSize: 5,
		Visibility: string(VisibilitySpace),
	})
	if err != nil {
		t.Fatalf("reserve upload: %v", err)
	}
	if reserved.ID == "" || reserved.Attachment == nil || reserved.Attachment.Status != string(AttachmentPending) {
		t.Fatalf("reserve result = %#v", reserved)
	}
	completed, err := service.UploadContent(ctx, "usr_file_owner", reserved.ID, stringsReader("hello"), authMeta())
	if err != nil {
		t.Fatalf("complete upload: %v", err)
	}
	if completed.Attachment == nil || completed.Attachment.Status != string(AttachmentAvailable) {
		t.Fatalf("complete result = %#v", completed)
	}
	attachment, err := repository.GetAttachment(ctx, DefaultSpaceID, completed.Attachment.ID)
	if err != nil || attachment == nil || attachment.StorageObject == nil {
		t.Fatalf("registered attachment = %#v, err = %v", attachment, err)
	}
	objectPath := filepath.Join(root, filepath.FromSlash(attachment.StorageObject.ObjectKey))
	if _, err := os.Stat(objectPath); err != nil {
		t.Fatalf("canonical object missing: %v", err)
	}

	// The member has no conversation_members row. Space visibility is still
	// authorized by the active space membership and remains listable/downloadable.
	items, err := service.ListFiles(ctx, ListFilesInput{ActorID: "usr_file_member"})
	if err != nil || len(items) != 1 || items[0].ID != attachment.ID {
		t.Fatalf("member file list = %#v, err = %v", items, err)
	}
	download, err := service.ReserveDownload(ctx, ReserveDownloadInput{ActorID: "usr_file_member", AttachmentID: attachment.ID})
	if err != nil {
		t.Fatalf("reserve download: %v", err)
	}
	opened, err := service.OpenDownload(ctx, CompletedDownloadInput{ActorID: "usr_file_member", AttachmentID: attachment.ID, TransferID: download.ID, MaxBytes: 5})
	if err != nil {
		t.Fatalf("open download: %v", err)
	}
	content, err := io.ReadAll(opened.Body)
	_ = opened.Body.Close()
	if err != nil || string(content) != "hello" {
		t.Fatalf("download content = %q, err = %v", content, err)
	}
	secondReserved, err := service.ReserveUpload(ctx, ReserveUploadInput{
		ActorID: "usr_file_owner", FileName: "report-copy.txt", MIMEType: "text/plain", ByteSize: 5,
		Visibility: string(VisibilitySpace),
	})
	if err != nil {
		t.Fatalf("reserve duplicate upload: %v", err)
	}
	secondCompleted, err := service.UploadContent(ctx, "usr_file_owner", secondReserved.ID, stringsReader("hello"), authMeta())
	if err != nil {
		t.Fatalf("complete duplicate upload: %v", err)
	}
	secondAttachment, err := repository.GetAttachment(ctx, DefaultSpaceID, secondCompleted.Attachment.ID)
	if err != nil || secondAttachment == nil || secondAttachment.StorageObject == nil {
		t.Fatalf("duplicate attachment = %#v, err = %v", secondAttachment, err)
	}
	if secondAttachment.StorageObject.ID != attachment.StorageObject.ID {
		t.Fatalf("CAS object ids = %q and %q", attachment.StorageObject.ID, secondAttachment.StorageObject.ID)
	}

	if _, err := service.RemoveAttachment(ctx, RemoveAttachmentInput{ActorID: "usr_file_owner", AttachmentID: attachment.ID}); err != nil {
		t.Fatalf("remove attachment: %v", err)
	}
	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM attachments WHERE id = $1`, attachment.ID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != string(AttachmentRemoved) {
		t.Fatalf("removed attachment status = %q", status)
	}
	if _, err := os.Stat(objectPath); err != nil {
		t.Fatalf("shared canonical object removed early: %v", err)
	}
	if _, err := service.RemoveAttachment(ctx, RemoveAttachmentInput{ActorID: "usr_file_owner", AttachmentID: secondAttachment.ID}); err != nil {
		t.Fatalf("remove duplicate attachment: %v", err)
	}
	if _, err := os.Stat(objectPath); !os.IsNotExist(err) {
		t.Fatalf("canonical object still exists, stat err = %v", err)
	}

	var rejectedEventCount, rejectedAuditCount int
	quotaService := NewService(ServiceOptions{Repository: repository, BlobStore: store, SpaceID: DefaultSpaceID, Now: func() time.Time { return now }, IDFactory: idFactory, DailyQuotaBytes: 4})
	rejected, err := quotaService.ReserveUpload(ctx, ReserveUploadInput{ActorID: "usr_file_owner", FileName: "too-large.txt", ByteSize: 5, Visibility: string(VisibilitySpace)})
	if err != nil || rejected.Status != string(TransferRejected) || rejected.ID != "" {
		t.Fatalf("quota rejection = %#v, err = %v", rejected, err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM workspace_events WHERE type = 'transfer.rejected'`).Scan(&rejectedEventCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM audit_logs WHERE action = 'file.upload.rejected'`).Scan(&rejectedAuditCount); err != nil {
		t.Fatal(err)
	}
	if rejectedEventCount != 1 || rejectedAuditCount != 1 {
		t.Fatalf("quota evidence events=%d audits=%d", rejectedEventCount, rejectedAuditCount)
	}

	if _, err := conn.Exec(ctx, `CREATE FUNCTION fail_file_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced file audit failure'; END $$`); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `CREATE TRIGGER fail_file_reserve_audit BEFORE INSERT ON audit_logs FOR EACH ROW WHEN (NEW.action = 'file.upload.reserve') EXECUTE FUNCTION fail_file_audit()`); err != nil {
		t.Fatal(err)
	}
	var beforeAttachments, beforeTransfers, beforeEvents, beforeAudits int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM attachments`).Scan(&beforeAttachments); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM transfer_ledger`).Scan(&beforeTransfers); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM workspace_events`).Scan(&beforeEvents); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM audit_logs`).Scan(&beforeAudits); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ReserveUpload(ctx, ReserveUploadInput{ActorID: "usr_file_owner", FileName: "rollback.txt", ByteSize: 1, Visibility: string(VisibilitySpace)}); errorCode(err) != CodeInternal {
		t.Fatalf("forced audit error code = %q, err = %v", errorCode(err), err)
	}
	var afterAttachments, afterTransfers, afterEvents, afterAudits int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM attachments`).Scan(&afterAttachments); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM transfer_ledger`).Scan(&afterTransfers); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM workspace_events`).Scan(&afterEvents); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM audit_logs`).Scan(&afterAudits); err != nil {
		t.Fatal(err)
	}
	if beforeAttachments != afterAttachments || beforeTransfers != afterTransfers || beforeEvents != afterEvents || beforeAudits != afterAudits {
		t.Fatalf("audit failure was not atomic: before=%d/%d/%d/%d after=%d/%d/%d/%d", beforeAttachments, beforeTransfers, beforeEvents, beforeAudits, afterAttachments, afterTransfers, afterEvents, afterAudits)
	}
}

func seedPGFilesData(t *testing.T, ctx context.Context, conn *pgx.Conn, now time.Time) {
	t.Helper()
	for _, user := range []struct{ id, login, name, role string }{
		{"usr_file_owner", "file-owner", "Owner", "owner"},
		{"usr_file_member", "file-member", "Member", "member"},
	} {
		if _, err := conn.Exec(ctx, `INSERT INTO users (id, github_login, display_name, kind, created_at) VALUES ($1, $2, $3, 'human', $4)`, user.id, user.login, user.name, now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := conn.Exec(ctx, `INSERT INTO spaces (id, name, slug, created_by, created_at) VALUES ($1, 'Files', 'files-integration', $2, $3)`, DefaultSpaceID, "usr_file_owner", now); err != nil {
		t.Fatal(err)
	}
	for _, user := range []struct{ id, login, name, role string }{
		{"usr_file_owner", "file-owner", "Owner", "owner"},
		{"usr_file_member", "file-member", "Member", "member"},
	} {
		if _, err := conn.Exec(ctx, `INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4)`, DefaultSpaceID, user.id, user.role, now); err != nil {
			t.Fatal(err)
		}
	}
}

func stringsReader(value string) io.Reader {
	return strings.NewReader(value)
}

func authMeta() auth.RequestMeta {
	return auth.RequestMeta{RequestID: "file-integration"}
}
