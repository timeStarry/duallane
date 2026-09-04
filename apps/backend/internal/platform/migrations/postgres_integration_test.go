//go:build postgres_integration

package migrations_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	"github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
)

func TestPostgresRunnerAgainstCurrentMigrationHistory(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())

	schema := fmt.Sprintf("duallane_migration_%d", time.Now().UnixNano())
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer conn.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+schema+" CASCADE")
	if _, err := conn.Exec(ctx, "SET search_path TO "+schema); err != nil {
		t.Fatal(err)
	}

	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	directory := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../web/server/migrations"))
	files, err := migrations.Discover(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 {
		t.Fatal("current migration directory is empty")
	}

	runner := migrations.Runner{
		Beginner:  postgres.NewMigrationBeginner(conn),
		Directory: directory,
	}
	result, err := runner.Run(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.Applied != len(files) {
		t.Fatalf("Applied = %d, want %d", result.Applied, len(files))
	}

	var count int
	if err := conn.QueryRow(ctx, "SELECT COUNT(*) FROM schema_migrations").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != len(files) {
		t.Fatalf("schema_migrations count = %d, want %d", count, len(files))
	}

	second, err := runner.Run(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if second.Applied != 0 {
		t.Fatalf("second run applied %d migrations, want 0", second.Applied)
	}
}
