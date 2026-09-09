//go:build postgres_integration

package presence

import (
	"context"
	"errors"
	"fmt"
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
)

func TestPGPresenceLeasesAcrossInstancesAndUpgrade(t *testing.T) {
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

	schema := fmt.Sprintf("duallane_presence_%d", time.Now().UnixNano())
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
	// Upgrade an actual pre-lease schema with existing members, not merely an
	// empty database followed by an idempotent replay of CREATE TABLE.
	legacyDirectory := t.TempDir()
	entries, err := os.ReadDir(migrationDirectory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") || entry.Name() >= "031_" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(migrationDirectory, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(legacyDirectory, entry.Name()), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := (platformmigrations.Runner{Beginner: platformpostgres.NewMigrationBeginner(conn), Directory: legacyDirectory}).Run(ctx); err != nil {
		t.Fatal(err)
	}

	spaceID := "spc_presence_test"
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	seedPresenceData(t, ctx, conn, spaceID, now)
	var before, after int
	if err := conn.QueryRow(ctx, `SELECT COUNT(*) FROM space_members WHERE space_id=$1`, spaceID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if _, err := (platformmigrations.Runner{Beginner: platformpostgres.NewMigrationBeginner(conn), Directory: migrationDirectory}).Run(ctx); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(ctx, `SELECT COUNT(*) FROM space_members WHERE space_id=$1`, spaceID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before == 0 || after != before {
		t.Fatal("additive presence migration changed existing members")
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

	var current atomic.Value
	current.Store(now)
	var firstID atomic.Int64
	var secondID atomic.Int64
	repository := NewPGRepository(pool)
	serviceA := NewService(ServiceOptions{
		Repository: repository, SpaceID: spaceID, LeaseTTL: time.Minute,
		Now:       func() time.Time { return current.Load().(time.Time) },
		IDFactory: func() (string, error) { return fmt.Sprintf("instance-a-%d", firstID.Add(1)), nil },
	})
	serviceB := NewService(ServiceOptions{
		Repository: repository, SpaceID: spaceID, LeaseTTL: time.Minute,
		Now:       func() time.Time { return current.Load().(time.Time) },
		IDFactory: func() (string, error) { return fmt.Sprintf("instance-b-%d", secondID.Add(1)), nil },
	})

	// Two independent service instances represent two Go processes. Deleting
	// one random lease must not make the still-connected user offline.
	first, err := serviceA.Register(ctx, RegisterInput{UserID: "usr_presence_active", ActorKind: "human"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := serviceB.Register(ctx, RegisterInput{UserID: "usr_presence_active", ActorKind: "human"})
	if err != nil {
		t.Fatal(err)
	}
	if first.ConnectionID == second.ConnectionID {
		t.Fatal("connection ids are not per-connection opaque ids")
	}
	assertOnline(t, ctx, serviceA, "usr_presence_active", true)
	if err := serviceA.Delete(ctx, DeleteInput{Lease: first}); err != nil {
		t.Fatal(err)
	}
	assertOnline(t, ctx, serviceB, "usr_presence_active", true)
	if err := serviceB.Delete(ctx, DeleteInput{Lease: second}); err != nil {
		t.Fatal(err)
	}
	assertOnline(t, ctx, serviceA, "usr_presence_active", false)

	// A delayed cleanup for an old connection is scoped by the random id and
	// cannot delete a newer connection for the same user.
	oldLease, err := serviceA.Register(ctx, RegisterInput{UserID: "usr_presence_active", ActorKind: "human"})
	if err != nil {
		t.Fatal(err)
	}
	newLease, err := serviceB.Register(ctx, RegisterInput{UserID: "usr_presence_active", ActorKind: "human"})
	if err != nil {
		t.Fatal(err)
	}
	if err := serviceA.Delete(ctx, DeleteInput{Lease: oldLease}); err != nil {
		t.Fatal(err)
	}
	assertOnline(t, ctx, serviceA, "usr_presence_active", true)
	var remaining int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM workspace_presence_leases WHERE user_id = $1`, "usr_presence_active").Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 1 || newLease.ConnectionID == oldLease.ConnectionID {
		t.Fatalf("remaining leases=%d old=%q new=%q", remaining, oldLease.ConnectionID, newLease.ConnectionID)
	}
	if err := serviceB.Delete(ctx, DeleteInput{Lease: newLease}); err != nil {
		t.Fatal(err)
	}

	// A removed membership and a bot identity are never online, even if a
	// lease row is present or a caller attempts to register one.
	removed, err := serviceA.Register(ctx, RegisterInput{UserID: "usr_presence_removed", ActorKind: "human"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `UPDATE space_members SET removed_at = $1 WHERE space_id = $2 AND user_id = $3`, now, spaceID, "usr_presence_removed"); err != nil {
		t.Fatal(err)
	}
	assertOnline(t, ctx, serviceA, "usr_presence_removed", false)
	if err := serviceA.Renew(ctx, RenewInput{Lease: removed}); !errors.Is(err, ErrLeaseNotFound) {
		t.Fatalf("revoked membership renew error=%v", err)
	}
	if err := serviceA.Delete(ctx, DeleteInput{Lease: removed}); err != nil {
		t.Fatal(err)
	}
	if _, err := serviceA.Register(ctx, RegisterInput{UserID: "usr_presence_bot", ActorKind: "bot"}); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("bot registration error=%v", err)
	}

	// Explicit short TTL models a crashed socket. A bounded sweep then removes
	// the expired row in batches rather than accumulating history forever.
	crashAt := now.Add(10 * time.Minute)
	_, err = serviceA.Register(ctx, RegisterInput{UserID: "usr_presence_active", ActorKind: "human", Now: crashAt, TTL: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	current.Store(crashAt.Add(2 * time.Second))
	assertOnline(t, ctx, serviceA, "usr_presence_active", false)
	removedCount, err := serviceA.SweepExpired(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if removedCount != 1 {
		t.Fatalf("expired sweep removed=%d, want 1", removedCount)
	}

	// A renew that wins the row lock extends the lease before the sweeper's
	// delete predicate is evaluated. The invariant is checked repeatedly with
	// two real pool connections to exercise the PG lock ordering.
	for attempt := 0; attempt < 5; attempt++ {
		base := now.Add(time.Duration(attempt+20) * time.Minute)
		lease, err := serviceA.Register(ctx, RegisterInput{UserID: "usr_presence_active", ActorKind: "human", Now: base, TTL: time.Second})
		if err != nil {
			t.Fatal(err)
		}
		lockTx, err := conn.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := lockTx.Exec(ctx, `SELECT 1 FROM workspace_presence_leases WHERE space_id = $1 AND user_id = $2 AND connection_id = $3 FOR UPDATE`, lease.SpaceID, lease.UserID, lease.ConnectionID); err != nil {
			_ = lockTx.Rollback(ctx)
			t.Fatal(err)
		}
		renewDone := make(chan struct {
			ok  bool
			err error
		}, 1)
		go func() {
			renewed, renewErr := repository.Renew(ctx, RenewRecord{Lease: Lease{SpaceID: lease.SpaceID, UserID: lease.UserID, ConnectionID: lease.ConnectionID, LeaseUntil: base.Add(time.Minute)}, Now: base})
			renewDone <- struct {
				ok  bool
				err error
			}{renewed, renewErr}
		}()
		time.Sleep(20 * time.Millisecond)
		sweepDone := make(chan struct {
			count int
			err   error
		}, 1)
		go func() {
			count, sweepErr := repository.SweepExpired(ctx, SweepInput{Now: base.Add(2 * time.Second), Limit: 10})
			sweepDone <- struct {
				count int
				err   error
			}{count, sweepErr}
		}()
		time.Sleep(20 * time.Millisecond)
		if err := lockTx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		renewResult := <-renewDone
		sweepResult := <-sweepDone
		if renewResult.err != nil || sweepResult.err != nil {
			t.Fatalf("renew=%v sweep=%v", renewResult.err, sweepResult.err)
		}
		if renewResult.ok && sweepResult.count != 0 {
			t.Fatalf("renew won but sweep deleted %d rows", sweepResult.count)
		}
		if renewResult.ok {
			assertOnlineAt(t, ctx, repository, spaceID, "usr_presence_active", base.Add(2*time.Second), true)
			if err := serviceA.Delete(ctx, DeleteInput{Lease: lease}); err != nil {
				t.Fatal(err)
			}
		}
	}

	// The additive migration is safe to replay during a rolling upgrade.
	migration, err := os.ReadFile(filepath.Join(migrationDirectory, "031_workspace_presence_leases.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, string(migration)); err != nil {
		t.Fatalf("first additive migration replay: %v", err)
	}
	if _, err := conn.Exec(ctx, string(migration)); err != nil {
		t.Fatalf("second additive migration replay: %v", err)
	}
}

func seedPresenceData(t *testing.T, ctx context.Context, conn *pgx.Conn, spaceID string, now time.Time) {
	t.Helper()
	if _, err := conn.Exec(ctx, `INSERT INTO spaces (id, name, slug, created_at) VALUES ($1, 'Presence Test', $2, $3)`, spaceID, spaceID, now); err != nil {
		t.Fatal(err)
	}
	for _, user := range []struct {
		id, login, name, kind string
	}{
		{"usr_presence_active", "presence-active", "Presence Active", "human"},
		{"usr_presence_removed", "presence-removed", "Presence Removed", "human"},
		{"usr_presence_bot", "presence-bot", "Presence Bot", "bot"},
	} {
		if _, err := conn.Exec(ctx, `INSERT INTO users (id, github_login, display_name, kind, created_at) VALUES ($1, $2, $3, $4, $5)`, user.id, user.login, user.name, user.kind, now); err != nil {
			t.Fatal(err)
		}
		if _, err := conn.Exec(ctx, `INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES ($1, $2, 'member', $3)`, spaceID, user.id, now); err != nil {
			t.Fatal(err)
		}
	}
}

func assertOnline(t *testing.T, ctx context.Context, service *Service, userID string, want bool) {
	t.Helper()
	online, err := service.IsOnlineContext(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if online != want {
		t.Fatalf("online=%v, want %v", online, want)
	}
}

func assertOnlineAt(t *testing.T, ctx context.Context, repository Repository, spaceID, userID string, now time.Time, want bool) {
	t.Helper()
	online, err := repository.IsOnline(ctx, OnlineQuery{SpaceID: spaceID, UserID: userID, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	if online != want {
		t.Fatalf("online at %s = %v, want %v", now, online, want)
	}
}
