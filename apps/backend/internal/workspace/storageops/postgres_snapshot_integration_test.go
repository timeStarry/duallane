//go:build postgres_integration

package storageops

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

func TestPostgresSnapshotAndReadOnlyStores(t *testing.T) {
	ctx, pool := openStorageSnapshotDatabase(t)
	defer pool.Close()

	content := []byte("postgres storage operator bytes")
	digest := sha256.Sum256(content)
	hexDigest := hex.EncodeToString(digest[:])
	objectKey, err := storage.CanonicalObjectKey(hexDigest)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	if _, err := pool.Exec(ctx, `
INSERT INTO workspace_storage_objects (id, sha256, object_key, byte_size, content_type, created_at)
VALUES ($1, $2, $3, $4, 'application/octet-stream', $5)`, "wso_"+hexDigest, hexDigest, objectKey, len(content), now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO users (id, github_login, display_name, avatar_storage_key, avatar_version, avatar_storage_object_id, created_at)
VALUES ('usr_pg', 'pg-owner', 'PG Owner', 'workspace/profile-avatars/usr_pg/v1.webp', 'v1', $1, $2)`, "wso_"+hexDigest, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO attachments (id, space_id, uploader_id, status, byte_size, storage_key, storage_object_id, created_at)
VALUES ('att_pg', 'spc_default', 'usr_pg', 'available', $1, 'workspace/spc_default/att_pg/file.bin', $2, $3)`, len(content), "wso_"+hexDigest, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO workspace_custom_emotes (id, user_id, storage_key, storage_object_id, byte_size, created_at)
VALUES ('emo_pg', 'usr_pg', 'workspace/emotes/emo_pg/source.webp', $1, $2, $3)`, "wso_"+hexDigest, len(content), now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO transfer_ledger (id, space_id, user_id, direction, byte_size, status, created_at)
VALUES ('tr_completed', 'spc_default', 'usr_pg', 'upload', 4, 'completed', $1),
       ('tr_reserved', 'spc_default', 'usr_pg', 'upload', 3, 'reserved', $1)`, now); err != nil {
		t.Fatal(err)
	}

	expected := []string{"001_initial.sql", "010_workspace_uploads_and_emotes.sql", CanonicalStorageMigration}
	source, err := NewPostgresSnapshotSource(pool, PostgresSnapshotOptions{
		ExpectedMigrations: expected, DailyQuotaBytes: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := source.Snapshot(ctx, SnapshotRequest{RunID: "storage-pg-2026"})
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Objects) != 1 || manifest.Objects[0].ReferenceCount != 3 {
		t.Fatalf("objects = %#v", manifest.Objects)
	}
	if len(manifest.Resources) != 3 {
		t.Fatalf("resources = %#v", manifest.Resources)
	}
	for _, resource := range manifest.Resources {
		if resource.LegacyStorageKey == "" || resource.StorageObjectID != "wso_"+hexDigest {
			t.Fatalf("resource lost canonical/legacy binding = %#v", resource)
		}
	}
	if len(manifest.Quotas) != 1 || manifest.Quotas[0].UsedBytes != 4 || manifest.Quotas[0].ReservedBytes != 3 {
		t.Fatalf("quotas = %#v", manifest.Quotas)
	}
	plan, err := BuildPlan(manifest, PlanOptions{Operation: "verify", Now: now})
	if err != nil || plan.Status != "ready" || !plan.Validation.ReadOnlyReady {
		t.Fatalf("plan = %#v, err = %v", plan, err)
	}

	localRoot := t.TempDir()
	localPath := filepath.Join(localRoot, filepath.FromSlash(objectKey))
	if err := os.MkdirAll(filepath.Dir(localPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(localPath, content, 0o600); err != nil {
		t.Fatal(err)
	}
	localStore, err := OpenReadOnlyStore(ctx, ReadOnlyStoreOptions{Kind: ReadOnlyLocalStore, ObjectRoot: localRoot})
	if err != nil {
		t.Fatal(err)
	}
	localReport, err := Verify(ctx, manifest, VerifyOptions{Store: localStore, Now: now})
	_ = localStore.Close()
	if err != nil || localReport.ObjectsVerified != 1 || localReport.Mutations != 0 {
		t.Fatalf("local verification = %#v, err = %v", localReport, err)
	}

	s3Server := newSnapshotS3Server(t, objectKey, content, hexDigest)
	defer s3Server.Close()
	s3Store, err := OpenReadOnlyStore(ctx, ReadOnlyStoreOptions{
		Kind: ReadOnlyS3Store,
		S3:   storage.S3Config{Endpoint: s3Server.URL, Region: "us-east-1", Bucket: "operator-bucket", AccessKey: "access", SecretKey: "secret"},
	})
	if err != nil {
		t.Fatal(err)
	}
	s3Report, err := Verify(ctx, manifest, VerifyOptions{Store: s3Store, Now: now})
	_ = s3Store.Close()
	if err != nil || s3Report.ObjectsVerified != 1 || s3Report.Mutations != 0 {
		t.Fatalf("S3 verification = %#v, err = %v", s3Report, err)
	}
}

func TestPostgresSnapshotRejectsOversizeCatalog(t *testing.T) {
	ctx, pool := openStorageSnapshotDatabase(t)
	defer pool.Close()
	if _, err := pool.Exec(ctx, `INSERT INTO workspace_storage_objects
		(id, sha256, object_key, byte_size, created_at)
		SELECT 'object_' || n, 'digest_' || n, 'key_' || n, 0, now()
		FROM generate_series(1, $1::integer) n`, MaxSnapshotRows+1); err != nil {
		t.Fatal(err)
	}
	source, err := NewPostgresSnapshotSource(pool, PostgresSnapshotOptions{ExpectedMigrations: []string{CanonicalStorageMigration}})
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := source.Snapshot(ctx, SnapshotRequest{RunID: "storage-limit-test"})
	if !errors.Is(err, ErrSnapshotFailed) || len(manifest.Objects) != 0 {
		t.Fatalf("oversize snapshot did not fail atomically: objects=%d, err=%v", len(manifest.Objects), err)
	}
}

func openStorageSnapshotDatabase(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	rootConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	rootPool, err := pgxpool.NewWithConfig(ctx, rootConfig)
	if err != nil {
		t.Fatal(err)
	}
	if err := rootPool.Ping(ctx); err != nil {
		rootPool.Close()
		t.Fatal(err)
	}
	schema := fmt.Sprintf("duallane_storageops_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := rootPool.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		rootPool.Close()
		t.Fatal(err)
	}
	rootPool.Close()

	poolConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	poolConfig.MaxConns = 2
	poolConfig.ConnConfig.RuntimeParams["search_path"] = identifier
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	createStorageSnapshotSchema(t, ctx, pool)
	if _, err := pool.Exec(ctx, `INSERT INTO schema_migrations (name, applied_at)
VALUES ('001_initial.sql', now()), ('010_workspace_uploads_and_emotes.sql', now()), ($1, now())`, CanonicalStorageMigration); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		cleanupConfig, parseErr := pgxpool.ParseConfig(dsn)
		if parseErr != nil {
			return
		}
		cleanupPool, openErr := pgxpool.NewWithConfig(context.Background(), cleanupConfig)
		if openErr != nil {
			return
		}
		defer cleanupPool.Close()
		_, _ = cleanupPool.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+identifier+" CASCADE")
	})
	return ctx, pool
}

func createStorageSnapshotSchema(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	statements := []string{
		`CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL)`,
		`CREATE TABLE workspace_storage_objects (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, object_key TEXT NOT NULL UNIQUE, byte_size BIGINT NOT NULL, content_type TEXT, created_at TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMPTZ)`,
		`CREATE TABLE users (id TEXT PRIMARY KEY, github_login TEXT NOT NULL, display_name TEXT NOT NULL, avatar_storage_key TEXT, avatar_version TEXT, avatar_storage_object_id TEXT, created_at TIMESTAMPTZ NOT NULL)`,
		`CREATE TABLE attachments (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, uploader_id TEXT NOT NULL, status TEXT NOT NULL, byte_size BIGINT NOT NULL, storage_key TEXT, storage_object_id TEXT, created_at TIMESTAMPTZ NOT NULL)`,
		`CREATE TABLE workspace_custom_emotes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, storage_key TEXT, storage_object_id TEXT, byte_size BIGINT, created_at TIMESTAMPTZ NOT NULL)`,
		`CREATE TABLE transfer_ledger (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, user_id TEXT NOT NULL, direction TEXT NOT NULL, byte_size BIGINT NOT NULL, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
	}
	for _, statement := range statements {
		if _, err := pool.Exec(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
}

func newSnapshotS3Server(t *testing.T, objectKey string, content []byte, digest string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		path := strings.TrimPrefix(request.URL.Path, "/")
		if path == "operator-bucket" && request.Method == http.MethodHead {
			response.WriteHeader(http.StatusOK)
			return
		}
		if path != "operator-bucket/"+objectKey {
			response.WriteHeader(http.StatusNotFound)
			return
		}
		response.Header().Set("Content-Length", fmt.Sprintf("%d", len(content)))
		response.Header().Set("Content-Type", "application/octet-stream")
		response.Header().Set("X-Amz-Meta-Duallane-Sha256", digest)
		response.Header().Set("X-Amz-Meta-Duallane-Size", fmt.Sprintf("%d", len(content)))
		if request.Method == http.MethodHead {
			response.WriteHeader(http.StatusOK)
			return
		}
		_, _ = io.Copy(response, bytes.NewReader(content))
	}))
}
