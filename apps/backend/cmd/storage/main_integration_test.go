//go:build postgres_integration

package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/storageops"
)

func TestPostgresPlanAndVerifyCommandsUseReadOnlySnapshot(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	schema, pool := openCLIIntegrationDatabase(t, ctx, dsn)
	defer pool.Close()

	migrationsDir := t.TempDir()
	for _, name := range []string{"001_initial.sql", "010_workspace_uploads_and_emotes.sql", storageops.CanonicalStorageMigration} {
		if err := os.WriteFile(filepath.Join(migrationsDir, name), []byte("-- synthetic test catalog\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	objectRoot := t.TempDir()
	var planOutput bytes.Buffer
	if err := run([]string{
		"plan", "--target", "postgres", "--database-url", dsn, "--schema", schema,
		"--migrations-dir", migrationsDir, "--run-id", "storage-cli-pg", "--now", "2026-09-06T12:00:00Z",
	}, &planOutput, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(planOutput.String(), `"status": "ready"`) || !strings.Contains(planOutput.String(), `"readOnly": true`) {
		t.Fatalf("plan output = %s", planOutput.String())
	}

	var verifyOutput bytes.Buffer
	if err := run([]string{
		"verify", "--target", "postgres", "--store", "local", "--database-url", dsn, "--schema", schema,
		"--migrations-dir", migrationsDir, "--object-root", objectRoot, "--run-id", "storage-cli-pg",
		"--now", "2026-09-06T12:00:00Z",
	}, &verifyOutput, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(verifyOutput.String(), `"status": "verified"`) || !strings.Contains(verifyOutput.String(), `"mutations": 0`) {
		t.Fatalf("verify output = %s", verifyOutput.String())
	}

	var migrationRows int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM schema_migrations`).Scan(&migrationRows); err != nil {
		t.Fatal(err)
	}
	if migrationRows != 3 {
		t.Fatalf("read-only CLI changed migration history: %d", migrationRows)
	}
}

func openCLIIntegrationDatabase(t *testing.T, ctx context.Context, dsn string) (string, *pgxpool.Pool) {
	t.Helper()
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
	schema := fmt.Sprintf("duallane_storagecli_%d", time.Now().UnixNano())
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
	for _, statement := range []string{
		`CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL)`,
		`CREATE TABLE workspace_storage_objects (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, object_key TEXT NOT NULL UNIQUE, byte_size BIGINT NOT NULL, content_type TEXT, created_at TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMPTZ)`,
		`CREATE TABLE users (id TEXT PRIMARY KEY, avatar_storage_key TEXT, avatar_version TEXT, avatar_storage_object_id TEXT)`,
		`CREATE TABLE attachments (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, uploader_id TEXT NOT NULL, status TEXT NOT NULL, byte_size BIGINT NOT NULL, storage_key TEXT, storage_object_id TEXT)`,
		`CREATE TABLE workspace_custom_emotes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, storage_key TEXT, storage_object_id TEXT, byte_size BIGINT)`,
		`CREATE TABLE transfer_ledger (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, user_id TEXT NOT NULL, direction TEXT NOT NULL, byte_size BIGINT NOT NULL, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
	} {
		if _, err := pool.Exec(ctx, statement); err != nil {
			pool.Close()
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO schema_migrations (name, applied_at)
VALUES ('001_initial.sql', now()), ('010_workspace_uploads_and_emotes.sql', now()), ($1, now())`, storageops.CanonicalStorageMigration); err != nil {
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
	return schema, pool
}
