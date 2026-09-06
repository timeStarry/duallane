//go:build postgres_integration

package files

import (
	"context"
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

type maintenanceReadBarrierRepository struct {
	*PGRepository
	listed chan struct{}
	resume chan struct{}
	once   sync.Once
}

func (r *maintenanceReadBarrierRepository) ListUploadMaintenancePage(ctx context.Context, spaceID string, before time.Time, after *UploadMaintenanceCursor, limit int, includeTerminal bool) (UploadMaintenancePage, error) {
	page, err := r.PGRepository.ListUploadMaintenancePage(ctx, spaceID, before, after, limit, includeTerminal)
	r.once.Do(func() { close(r.listed) })
	if err != nil {
		return UploadMaintenancePage{}, err
	}
	<-r.resume
	return page, nil
}

func TestPGUploadMaintenanceTouchWinsAfterCandidateRead(t *testing.T) {
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
	schema := fmt.Sprintf("duallane_files_maintenance_%d", time.Now().UnixNano())
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
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
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
	var sequence int
	var sequenceMu sync.Mutex
	idFactory := func() (string, error) {
		sequenceMu.Lock()
		defer sequenceMu.Unlock()
		sequence++
		return fmt.Sprintf("maintenance-id-%03d", sequence), nil
	}
	repository := NewPGRepository(pool, idFactory)
	store, err := platformstorage.NewLocalBlobStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(ServiceOptions{Repository: repository, BlobStore: store, SpaceID: DefaultSpaceID, Now: func() time.Time { return now }, IDFactory: idFactory})
	reserved, err := service.ReserveUpload(ctx, ReserveUploadInput{ActorID: "usr_file_owner", FileName: "barrier.txt", MIMEType: "text/plain", ByteSize: 7, Visibility: string(VisibilitySpace)})
	if err != nil {
		t.Fatalf("reserve upload: %v", err)
	}
	old := now.Add(-time.Hour)
	if _, err := pool.Exec(ctx, `UPDATE transfer_ledger SET last_activity_at = $1 WHERE id = $2`, old, reserved.ID); err != nil {
		t.Fatal(err)
	}

	barrier := &maintenanceReadBarrierRepository{PGRepository: repository, listed: make(chan struct{}), resume: make(chan struct{})}
	barrierService := NewService(ServiceOptions{Repository: barrier, BlobStore: store, SpaceID: DefaultSpaceID, Now: func() time.Time { return now }, IDFactory: idFactory})
	type maintenanceCall struct {
		result UploadMaintenanceResult
		err    error
	}
	done := make(chan maintenanceCall, 1)
	go func() {
		result, callErr := barrierService.RunUploadMaintenance(ctx, UploadMaintenanceOptions{Now: now, IncludeTerminalArtifacts: false})
		done <- maintenanceCall{result: result, err: callErr}
	}()
	select {
	case <-barrier.listed:
	case <-time.After(10 * time.Second):
		close(barrier.resume)
		t.Fatal("maintenance candidate read barrier was not reached")
	}
	touchErr := repository.WithTx(ctx, func(tx Tx) error {
		if err := tx.Lock(ctx, uploadLockKey(reserved.ID)); err != nil {
			return err
		}
		return tx.TouchUpload(ctx, reserved.ID, now)
	})
	if touchErr != nil {
		close(barrier.resume)
		t.Fatalf("touch upload: %v", touchErr)
	}
	close(barrier.resume)
	call := <-done
	if call.err != nil {
		t.Fatalf("maintenance: %v", call.err)
	}
	if call.result.StaleReservationsFailed != 0 {
		t.Fatalf("freshly touched reservation was failed: %#v", call.result)
	}
	current, err := repository.GetTransfer(ctx, DefaultSpaceID, "usr_file_owner", reserved.ID, TransferUpload)
	if err != nil || current == nil {
		t.Fatalf("current transfer = %#v, err=%v", current, err)
	}
	if current.Status != string(TransferReserved) || current.LastActivityAt == nil || !current.LastActivityAt.Equal(now) {
		t.Fatalf("touch did not win: %#v", current)
	}
	var events, audits int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM workspace_events WHERE type = 'attachment.failed' AND target_id = $1`, reserved.Attachment.ID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM audit_logs WHERE action = 'file.upload.failed' AND target_id = $1`, reserved.Attachment.ID).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if events != 0 || audits != 0 {
		t.Fatalf("fresh upload emitted failure evidence: events=%d audits=%d", events, audits)
	}
	if _, err := pool.Exec(ctx, `UPDATE transfer_ledger SET last_activity_at = $1 WHERE id = $2`, old, reserved.ID); err != nil {
		t.Fatal(err)
	}
	released, err := service.ReleaseStaleUploadReservations(ctx)
	if err != nil {
		t.Fatalf("release stale upload: %v", err)
	}
	if released != 1 {
		t.Fatalf("released stale uploads = %d", released)
	}
	current, err = repository.GetTransfer(ctx, DefaultSpaceID, "usr_file_owner", reserved.ID, TransferUpload)
	if err != nil || current == nil || current.Status != string(TransferFailed) {
		t.Fatalf("stale transfer was not failed: %#v, err=%v", current, err)
	}
	used, err := repository.UsedTransferBytes(ctx, DefaultSpaceID, "usr_file_owner", dayStart(now))
	if err != nil {
		t.Fatal(err)
	}
	if used != 0 {
		t.Fatalf("failed upload still consumes quota: %d", used)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM workspace_events WHERE type = 'attachment.failed' AND target_id = $1`, reserved.Attachment.ID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM audit_logs WHERE action = 'file.upload.failed' AND target_id = $1`, reserved.Attachment.ID).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if events != 1 || audits != 1 {
		t.Fatalf("stale failure evidence counts: events=%d audits=%d", events, audits)
	}
}
