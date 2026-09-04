//go:build postgres_integration

package seed

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

func TestRunMatchesCurrentWorkspaceBootstrapAndIsIdempotent(t *testing.T) {
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

	schema := fmt.Sprintf("duallane_seed_%d", time.Now().UnixNano())
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
	directory := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../web/server/migrations"))
	if _, err := (migrations.Runner{Beginner: postgres.NewMigrationBeginner(conn), Directory: directory}).Run(ctx); err != nil {
		t.Fatal(err)
	}
	if err := Run(ctx, conn); err != nil {
		t.Fatal(err)
	}
	if err := Run(ctx, conn); err != nil {
		t.Fatalf("second seed: %v", err)
	}

	for query, want := range map[string]int{
		"SELECT COUNT(*) FROM users WHERE id IN ('usr_owner', 'usr_system_beacon', 'usr_system_echo')": 3,
		"SELECT COUNT(*) FROM space_members WHERE space_id = 'spc_default' AND removed_at IS NULL":     3,
		"SELECT COUNT(*) FROM workspace_events WHERE id = 'evt_seed_owner' AND seq = 1":                1,
		"SELECT COUNT(*) FROM audit_logs WHERE id = 'aud_seed_owner'":                                  1,
	} {
		var got int
		if err := conn.QueryRow(ctx, query).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("%s = %d, want %d", query, got, want)
		}
	}
	var nextSequence int64
	if err := conn.QueryRow(ctx, "SELECT next_seq FROM workspace_event_cursors WHERE space_id = $1", DefaultSpaceID).Scan(&nextSequence); err != nil {
		t.Fatal(err)
	}
	if nextSequence != 2 {
		t.Fatalf("next event sequence = %d, want 2", nextSequence)
	}
}
