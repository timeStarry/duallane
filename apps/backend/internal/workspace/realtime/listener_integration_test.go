//go:build postgres_integration

package realtime

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
)

func TestPGListenerReceivesCommittedEventTrigger(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	connection, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close(context.Background())
	schema := fmt.Sprintf("duallane_realtime_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := connection.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanup, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = connection.Exec(cleanup, "DROP SCHEMA IF EXISTS "+identifier+" CASCADE")
	}()
	if _, err := connection.Exec(ctx, "SET search_path TO "+identifier); err != nil {
		t.Fatal(err)
	}
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	migrationDirectory := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../web/server/migrations"))
	if _, err := (migrations.Runner{
		Beginner: platformpostgres.NewMigrationBeginner(connection), Directory: migrationDirectory,
	}).Run(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Exec(ctx, `
		INSERT INTO spaces (id, name, slug, created_at)
		VALUES ('spc_default', 'Realtime', $1, $2)
	`, "realtime-"+schema, time.Now().UTC()); err != nil {
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
	defer pool.Close()
	hub := NewHub()
	wakeup, unsubscribe := hub.Subscribe()
	defer unsubscribe()
	listenerContext, stopListener := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- NewPGListener(ListenerOptions{
			Pool: pool, Hub: hub, ReconnectMinimum: 10 * time.Millisecond, ReconnectMaximum: 50 * time.Millisecond,
		}).Run(listenerContext)
	}()
	awaitWakeup(t, wakeup, "listener startup")

	transaction, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := transaction.Exec(ctx, `
		INSERT INTO workspace_events (
			id, space_id, seq, type, payload_json, created_at
		) VALUES ('evt-notify', 'spc_default', 1, 'unknown', '{}', $1)
	`, time.Now().UTC()); err != nil {
		_ = transaction.Rollback(ctx)
		t.Fatal(err)
	}
	select {
	case <-wakeup:
		_ = transaction.Rollback(ctx)
		t.Fatal("listener received an event before its transaction committed")
	case <-time.After(150 * time.Millisecond):
	}
	if err := transaction.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	awaitWakeup(t, wakeup, "committed event")
	stopListener()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("listener did not stop after cancellation")
	}
}

func awaitWakeup(t *testing.T, wakeup <-chan struct{}, phase string) {
	t.Helper()
	select {
	case <-wakeup:
	case <-time.After(3 * time.Second):
		t.Fatalf("timed out waiting for %s wake-up", phase)
	}
}
