//go:build postgres_integration

package files

import (
	"context"
	"errors"
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
)

type observedFileStore struct {
	platformstorage.BlobStore
	afterCanonicalPut func(context.Context, platformstorage.StoredObject) error
	beforeDelete      func(context.Context, platformstorage.Object) error
}

func (s *observedFileStore) Put(ctx context.Context, key string, body io.Reader, size int64, digest string) (platformstorage.StoredObject, error) {
	object, err := s.BlobStore.Put(ctx, key, body, size, digest)
	if err == nil && strings.HasPrefix(key, "workspace/objects/sha256/") && s.afterCanonicalPut != nil {
		err = s.afterCanonicalPut(ctx, object)
	}
	return object, err
}

func (s *observedFileStore) Delete(ctx context.Context, object platformstorage.Object) error {
	if strings.HasPrefix(object.Key, "workspace/objects/sha256/") && s.beforeDelete != nil {
		if err := s.beforeDelete(ctx, object); err != nil {
			return err
		}
	}
	return s.BlobStore.Delete(ctx, object)
}

// Each hook is a barrier at the physical mutation, not a scheduler-dependent
// sleep. The second connection represents any attachment/avatar/emote owner.
func TestPGFilesCanonicalPutExcludesConcurrentCleanup(t *testing.T) {
	ctx, pool, service, store := newStorageLockFixture(t)
	var observations int
	store.afterCanonicalPut = func(operationCtx context.Context, stored platformstorage.StoredObject) error {
		observations++
		assertObjectLockHeld(t, ctx, pool, "wso_"+stored.SHA256)
		if _, bounded := operationCtx.Deadline(); !bounded {
			t.Error("canonical promotion has no deadline")
		}
		object, err := canonicalObjectRecord(stored.SHA256, stored.ByteSize, "text/plain", service.nowUTC())
		if err != nil {
			return err
		}
		// Before the fix this cleanup succeeds between Put and bind, and the
		// attachment becomes available with its canonical bytes already gone.
		competingCtx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
		defer cancel()
		if err := service.cleanupObject(competingCtx, object); err == nil {
			t.Error("cleanup crossed the canonical Put/bind barrier")
		}
		return nil
	}
	completed := completeFixtureUpload(t, context.Background(), service, "shared content")
	if observations != 1 {
		t.Fatalf("canonical Put observations = %d", observations)
	}
	assertFixtureBytes(t, ctx, service, completed.Attachment.ID, "shared content")
}

func TestPGFilesPhysicalDeleteKeepsObjectLockAndUncommittedTombstone(t *testing.T) {
	ctx, pool, service, store := newStorageLockFixture(t)
	completed := completeFixtureUpload(t, ctx, service, "shared content")
	attachment, err := service.repo.GetAttachment(ctx, DefaultSpaceID, completed.Attachment.ID)
	if err != nil || attachment == nil || attachment.StorageObject == nil {
		t.Fatalf("attachment = %#v, err = %v", attachment, err)
	}
	var observations int
	store.beforeDelete = func(operationCtx context.Context, object platformstorage.Object) error {
		observations++
		assertObjectLockHeld(t, ctx, pool, attachment.StorageObject.ID)
		if _, bounded := operationCtx.Deadline(); !bounded {
			t.Error("physical deletion has no deadline")
		}
		var tombstoned bool
		if err := pool.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM workspace_storage_objects WHERE id = $1`, attachment.StorageObject.ID).Scan(&tombstoned); err != nil {
			return err
		}
		if tombstoned {
			t.Error("tombstone committed before physical deletion")
		}
		return nil
	}
	if _, err := service.RemoveAttachment(context.Background(), RemoveAttachmentInput{ActorID: "usr_file_owner", AttachmentID: completed.Attachment.ID}); err != nil {
		t.Fatal(err)
	}
	if observations != 1 {
		t.Fatalf("physical Delete observations = %d", observations)
	}
	// A later acquisition must recreate and revive the exact same digest.
	store.beforeDelete = nil
	reacquired := completeFixtureUpload(t, ctx, service, "shared content")
	assertFixtureBytes(t, ctx, service, reacquired.Attachment.ID, "shared content")
}

func TestPGFilesFailedPhysicalDeleteRollsBackTombstoneAndCanRetry(t *testing.T) {
	ctx, pool, service, store := newStorageLockFixture(t)
	completed := completeFixtureUpload(t, ctx, service, "retry deletion")
	attachment, err := service.repo.GetAttachment(ctx, DefaultSpaceID, completed.Attachment.ID)
	if err != nil || attachment == nil || attachment.StorageObject == nil {
		t.Fatalf("attachment = %#v, err = %v", attachment, err)
	}
	store.beforeDelete = func(context.Context, platformstorage.Object) error {
		return errors.New("synthetic storage outage")
	}
	// Logical removal remains committed; failed cleanup must not record the
	// physical deletion as successful or hide the object from maintenance.
	_, _ = service.RemoveAttachment(ctx, RemoveAttachmentInput{ActorID: "usr_file_owner", AttachmentID: completed.Attachment.ID})
	var tombstoned bool
	if err := pool.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM workspace_storage_objects WHERE id = $1`, attachment.StorageObject.ID).Scan(&tombstoned); err != nil {
		t.Fatal(err)
	}
	if tombstoned {
		t.Error("failed physical deletion committed a tombstone")
	}
	opened, err := store.Open(ctx, attachment.StorageObject.BlobObject(), attachment.StorageObject.ByteSize)
	if err != nil {
		t.Fatal(err)
	}
	_ = opened.Body.Close()
	store.beforeDelete = nil
	if err := service.cleanupObject(ctx, *attachment.StorageObject); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM workspace_storage_objects WHERE id = $1`, attachment.StorageObject.ID).Scan(&tombstoned); err != nil || !tombstoned {
		t.Fatalf("retry tombstoned = %v, err = %v", tombstoned, err)
	}
	if opened, err := store.Open(ctx, attachment.StorageObject.BlobObject(), attachment.StorageObject.ByteSize); err == nil {
		_ = opened.Body.Close()
		t.Fatal("retried physical deletion retained bytes")
	}
}

func assertObjectLockHeld(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id string) {
	t.Helper()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var acquired bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0))`, storageObjectLockKey(id)).Scan(&acquired); err != nil {
		t.Fatal(err)
	}
	if acquired {
		t.Error("physical mutation is not protected by the shared digest lock")
	}
}

func completeFixtureUpload(t *testing.T, ctx context.Context, service *Service, content string) UploadResult {
	t.Helper()
	reserved, err := service.ReserveUpload(ctx, ReserveUploadInput{ActorID: "usr_file_owner", FileName: "fixture.txt", MIMEType: "text/plain", ByteSize: int64(len(content)), Visibility: string(VisibilitySpace)})
	if err != nil {
		t.Fatal(err)
	}
	completed, err := service.UploadContent(ctx, "usr_file_owner", reserved.ID, strings.NewReader(content), authMeta())
	if err != nil || completed.Attachment == nil {
		t.Fatalf("complete upload = %#v, err = %v", completed, err)
	}
	return completed
}

func assertFixtureBytes(t *testing.T, ctx context.Context, service *Service, attachmentID, want string) {
	t.Helper()
	opened, err := service.OpenAttachmentContent(ctx, OpenAttachmentInput{ActorID: "usr_file_owner", AttachmentID: attachmentID, MaxBytes: int64(len(want))})
	if err != nil {
		t.Fatalf("bound canonical bytes missing: %v", err)
	}
	defer opened.Body.Close()
	got, err := io.ReadAll(opened.Body)
	if err != nil || string(got) != want {
		t.Fatalf("canonical content = %q, err = %v", got, err)
	}
}

func newStorageLockFixture(t *testing.T) (context.Context, *pgxpool.Pool, *Service, *observedFileStore) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	schema := fmt.Sprintf("duallane_file_lock_%d", time.Now().UnixNano())
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
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	if _, err := (platformmigrations.Runner{Beginner: platformpostgres.NewMigrationBeginner(conn), Directory: filepath.Join(filepath.Dir(source), "../../../../web/server/migrations")}).Run(ctx); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	seedPGFilesData(t, ctx, conn, now)
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	local, err := platformstorage.NewLocalBlobStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	store := &observedFileStore{BlobStore: local}
	var sequence atomic.Int64
	idFactory := func() (string, error) { return fmt.Sprintf("lock-fixture-%d", sequence.Add(1)), nil }
	service := NewService(ServiceOptions{Repository: NewPGRepository(pool, idFactory), BlobStore: store, Now: func() time.Time { return now }, IDFactory: idFactory})
	return ctx, pool, service, store
}
