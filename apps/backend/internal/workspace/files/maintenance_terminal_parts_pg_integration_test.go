//go:build postgres_integration

package files

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	platformmigrations "github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

type terminalPartsPGFixture struct {
	ctx        context.Context
	pool       *pgxpool.Pool
	repository *PGRepository
	service    *Service
	store      *platformstorage.LocalBlobStore
	now        time.Time
}

func newTerminalPartsPGFixture(t *testing.T) *terminalPartsPGFixture {
	t.Helper()
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
	schema := fmt.Sprintf("duallane_files_terminal_parts_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		_ = conn.Close(context.Background())
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := conn.Exec(cleanupCtx, "DROP SCHEMA IF EXISTS "+identifier+" CASCADE"); err != nil {
			t.Error("cleanup terminal-parts test schema failed")
		}
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
	store, err := platformstorage.NewLocalBlobStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC)
	repository := NewPGRepository(pool)
	service := NewService(ServiceOptions{
		Repository: repository,
		BlobStore:  store,
		SpaceID:    DefaultSpaceID,
		Now:        func() time.Time { return now },
	})
	seedPGFilesData(t, ctx, conn, now)
	return &terminalPartsPGFixture{ctx: ctx, pool: pool, repository: repository, service: service, store: store, now: now}
}

type terminalPartsUpload struct {
	id           string
	attachmentID string
}

func (f *terminalPartsPGFixture) reserveUpload(t *testing.T, name string) terminalPartsUpload {
	t.Helper()
	reserved, err := f.service.ReserveUpload(f.ctx, ReserveUploadInput{
		ActorID: "usr_file_owner", FileName: name, MIMEType: "text/plain", ByteSize: 7,
		Visibility: string(VisibilitySpace),
	})
	if err != nil || reserved.ID == "" || reserved.Attachment == nil {
		t.Fatalf("reserve upload: result=%#v err=%v", reserved, err)
	}
	return terminalPartsUpload{id: reserved.ID, attachmentID: reserved.Attachment.ID}
}

func (f *terminalPartsPGFixture) makeTerminal(t *testing.T, name string) terminalPartsUpload {
	t.Helper()
	upload := f.reserveUpload(t, name)
	old := f.now.Add(-time.Hour)
	if _, err := f.pool.Exec(f.ctx, `UPDATE transfer_ledger
		SET status = 'completed', completed_at = $1, released_at = NULL, last_activity_at = $1
		WHERE id = $2`, old, upload.id); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE attachments
		SET status = 'available', completed_at = $1
		WHERE id = $2`, old, upload.attachmentID); err != nil {
		t.Fatal(err)
	}
	return upload
}

func (f *terminalPartsPGFixture) insertPart(t *testing.T, uploadID string, partNumber int, at time.Time) {
	t.Helper()
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO workspace_upload_parts (
		upload_id, part_number, byte_size, sha256, created_at, updated_at
	) VALUES ($1, $2, 7, $3, $4, $4)`, uploadID, partNumber, fmt.Sprintf("%064x", partNumber), at); err != nil {
		t.Fatal(err)
	}
}

func (f *terminalPartsPGFixture) partCount(t *testing.T, uploadID string) int {
	t.Helper()
	var count int
	if err := f.pool.QueryRow(f.ctx, `SELECT COUNT(*) FROM workspace_upload_parts WHERE upload_id = $1`, uploadID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func (f *terminalPartsPGFixture) transferStatus(t *testing.T, uploadID string) string {
	t.Helper()
	var status string
	if err := f.pool.QueryRow(f.ctx, `SELECT status FROM transfer_ledger WHERE id = $1`, uploadID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	return status
}

func TestPGUploadMaintenanceDeletesExpiredTerminalPartsAndRetainsFreshReservedParts(t *testing.T) {
	fixture := newTerminalPartsPGFixture(t)
	terminal := fixture.makeTerminal(t, "terminal-parts.txt")
	fixture.insertPart(t, terminal.id, 7, fixture.now.Add(-time.Hour))
	fresh := fixture.reserveUpload(t, "fresh-parts.txt")
	fixture.insertPart(t, fresh.id, 1, fixture.now)
	extraKey := stagingPartKey(terminal.id, 7)
	if _, err := fixture.store.Put(fixture.ctx, extraKey, stringsReader("staging"), int64(len("staging")), ""); err != nil {
		t.Fatal(err)
	}

	result, err := fixture.service.RunUploadMaintenance(fixture.ctx, UploadMaintenanceOptions{
		Now: fixture.now, IncludeTerminalArtifacts: true,
	})
	if err != nil {
		t.Fatalf("terminal maintenance: %v", err)
	}
	if result.TerminalUploadsInspected != 1 || result.StaleReservationsFailed != 0 {
		t.Fatalf("maintenance result = %#v", result)
	}
	if got := fixture.partCount(t, terminal.id); got != 0 {
		t.Fatalf("terminal parts remaining = %d", got)
	}
	if got := fixture.partCount(t, fresh.id); got != 1 {
		t.Fatalf("fresh reserved parts = %d", got)
	}
	if got := fixture.transferStatus(t, fresh.id); got != string(TransferReserved) {
		t.Fatalf("fresh reserved status = %q", got)
	}
	opened, err := fixture.store.Open(fixture.ctx, platformstorage.Object{Key: extraKey, ByteSize: int64(len("staging"))}, int64(len("staging")))
	if opened.Body != nil {
		_ = opened.Body.Close()
	}
	if err == nil {
		t.Fatalf("collected terminal part object remains, err=%v", err)
	}

	second, err := fixture.service.RunUploadMaintenance(fixture.ctx, UploadMaintenanceOptions{
		Now: fixture.now, IncludeTerminalArtifacts: true,
	})
	if err != nil || second.TerminalUploadsInspected != 1 || fixture.partCount(t, terminal.id) != 0 {
		t.Fatalf("idempotent maintenance result=%#v err=%v parts=%d", second, err, fixture.partCount(t, terminal.id))
	}
}

func TestPGUploadMaintenanceConcurrentTerminalPartCleanupIsIdempotent(t *testing.T) {
	fixture := newTerminalPartsPGFixture(t)
	terminal := fixture.makeTerminal(t, "concurrent-terminal-parts.txt")
	fixture.insertPart(t, terminal.id, 17, fixture.now.Add(-time.Hour))
	fresh := fixture.reserveUpload(t, "concurrent-fresh-parts.txt")
	fixture.insertPart(t, fresh.id, 1, fixture.now)
	if _, err := fixture.store.Put(fixture.ctx, stagingPartKey(terminal.id, 17), stringsReader("staging"), int64(len("staging")), ""); err != nil {
		t.Fatal(err)
	}

	start := make(chan struct{})
	type call struct {
		result UploadMaintenanceResult
		err    error
	}
	results := make(chan call, 2)
	var group sync.WaitGroup
	for range 2 {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			result, err := fixture.service.RunUploadMaintenance(fixture.ctx, UploadMaintenanceOptions{
				Now: fixture.now, IncludeTerminalArtifacts: true,
			})
			results <- call{result: result, err: err}
		}()
	}
	close(start)
	group.Wait()
	close(results)
	for result := range results {
		if result.err != nil || result.result.Errors != 0 || result.result.TerminalUploadsInspected != 1 {
			t.Fatalf("concurrent maintenance result=%#v err=%v", result.result, result.err)
		}
	}
	if got := fixture.partCount(t, terminal.id); got != 0 {
		t.Fatalf("concurrent terminal parts remaining = %d", got)
	}
	if got := fixture.partCount(t, fresh.id); got != 1 {
		t.Fatalf("concurrent fresh reserved parts = %d", got)
	}
}

func TestPGUploadMaintenancePhysicalFailureRetainsLegacyPartMetadata(t *testing.T) {
	fixture := newTerminalPartsPGFixture(t)
	terminal := fixture.makeTerminal(t, "physical-failure-terminal-parts.txt")
	fixture.insertPart(t, terminal.id, 37, fixture.now.Add(-time.Hour))
	legacyPartKey := stagingPartKey(terminal.id, 37)
	if _, err := fixture.store.Put(fixture.ctx, legacyPartKey, stringsReader("staging"), int64(len("staging")), ""); err != nil {
		t.Fatal(err)
	}
	failingStore := &failingMaintenanceBlobStore{inner: fixture.store, failOn: legacyPartKey}
	service := NewService(ServiceOptions{
		Repository: fixture.repository,
		BlobStore:  failingStore,
		SpaceID:    DefaultSpaceID,
		Now:        func() time.Time { return fixture.now },
	})

	first, err := service.RunUploadMaintenance(fixture.ctx, UploadMaintenanceOptions{Now: fixture.now, IncludeTerminalArtifacts: true})
	if err == nil || first.ObjectFailures == 0 {
		t.Fatalf("expected physical cleanup failure: result=%#v err=%v", first, err)
	}
	if got := fixture.partCount(t, terminal.id); got != 1 {
		t.Fatalf("physical failure discarded legacy part metadata: %d", got)
	}
	opened, err := fixture.store.Open(fixture.ctx, platformstorage.Object{Key: legacyPartKey, ByteSize: int64(len("staging"))}, int64(len("staging")))
	if opened.Body != nil {
		_ = opened.Body.Close()
	}
	if err != nil {
		t.Fatalf("legacy staging object disappeared after physical failure: %v", err)
	}

	failingStore.failOn = ""
	second, err := service.RunUploadMaintenance(fixture.ctx, UploadMaintenanceOptions{Now: fixture.now, IncludeTerminalArtifacts: true})
	if err != nil {
		t.Fatalf("retry terminal cleanup: %v", err)
	}
	if got := fixture.partCount(t, terminal.id); got != 0 {
		t.Fatalf("successful retry left terminal parts: %d result=%#v", got, second)
	}
	opened, err = fixture.store.Open(fixture.ctx, platformstorage.Object{Key: legacyPartKey, ByteSize: int64(len("staging"))}, int64(len("staging")))
	if opened.Body != nil {
		_ = opened.Body.Close()
	}
	if err == nil {
		t.Fatalf("successful retry left legacy staging object: result=%#v", second)
	}
}

func TestPGUploadPartDeleteRollsBackWithOwningTransaction(t *testing.T) {
	fixture := newTerminalPartsPGFixture(t)
	terminal := fixture.makeTerminal(t, "rollback-terminal-parts.txt")
	fixture.insertPart(t, terminal.id, 3, fixture.now.Add(-time.Hour))
	wantErr := errors.New("synthetic maintenance rollback")
	err := fixture.repository.WithTx(fixture.ctx, func(tx Tx) error {
		if err := tx.Lock(fixture.ctx, uploadLockKey(terminal.id)); err != nil {
			return err
		}
		current, err := tx.GetTransfer(fixture.ctx, DefaultSpaceID, "usr_file_owner", terminal.id, TransferUpload)
		if err != nil || current == nil || !isTerminalUploadStatus(current.Status) {
			return fmt.Errorf("read terminal upload: %w", err)
		}
		if _, err := tx.ListUploadParts(fixture.ctx, terminal.id); err != nil {
			return err
		}
		if err := tx.DeleteUploadParts(fixture.ctx, terminal.id); err != nil {
			return err
		}
		return wantErr
	})
	if !errors.Is(err, wantErr) {
		t.Fatalf("rollback error = %v", err)
	}
	if got := fixture.partCount(t, terminal.id); got != 1 {
		t.Fatalf("rolled-back terminal parts = %d", got)
	}
}
