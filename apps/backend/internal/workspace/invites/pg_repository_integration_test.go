//go:build postgres_integration

package invites

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	workspaceseed "github.com/timestarry/duallane/apps/backend/internal/workspace/seed"
)

func TestPGRepositoryCreateAndRevokeLifecycle(t *testing.T) {
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

	schema := fmt.Sprintf("duallane_invites_%d", time.Now().UnixNano())
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
	if _, err := (migrations.Runner{Beginner: platformpostgres.NewMigrationBeginner(conn), Directory: directory}).Run(ctx); err != nil {
		t.Fatal(err)
	}
	if err := workspaceseed.Run(ctx, conn); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO users (id, github_login, display_name, kind, created_at)
		VALUES ('invite-admin', 'invite-admin', 'Invite Admin', 'human', NOW());
		INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
		VALUES ('spc_default', 'invite-admin', 'admin', NOW(), NULL)
	`); err != nil {
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

	var sequence atomic.Int64
	repository := NewPGRepository(pool, func() (string, error) {
		return fmt.Sprintf("invite-audit-%d", sequence.Add(1)), nil
	})
	now := time.Date(2026, 9, 4, 15, 0, 0, 987_000_000, time.UTC)
	service := NewService(ServiceOptions{
		Repository: repository,
		Now:        func() time.Time { return now },
		IDFactory:  func() (string, error) { return "invite-pg-member", nil },
	})
	invite, err := service.Create(ctx, CreateInput{
		ActorID: "invite-admin", Code: "PG-MEMBER-CODE", DefaultRole: "member", MaxUses: 3,
		Meta: RequestMeta{RequestID: "pg-create", IPAddress: "127.0.0.1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var codeHash string
	if err := pool.QueryRow(ctx, "SELECT code_hash FROM invites WHERE id = $1", invite.ID).Scan(&codeHash); err != nil {
		t.Fatal(err)
	}
	if codeHash == invite.Code || codeHash == "" {
		t.Fatal("raw invite code was persisted")
	}
	if _, err := service.Create(ctx, CreateInput{ActorID: "invite-admin", Code: "PG-OWNER-CODE", DefaultRole: "owner"}); !isCode(err, CodePermissionDenied) {
		t.Fatalf("admin privileged invite error = %v", err)
	}

	revoked, err := service.Revoke(ctx, RevokeInput{ActorID: "invite-admin", InviteID: invite.ID, Meta: RequestMeta{RequestID: "pg-revoke"}})
	if err != nil {
		t.Fatal(err)
	}
	again, err := service.Revoke(ctx, RevokeInput{ActorID: "invite-admin", InviteID: invite.ID})
	if err != nil || again.RevokedAt != revoked.RevokedAt {
		t.Fatalf("idempotent revoke = %#v, %v", again, err)
	}
	var createAudits, revokeAudits, rejectedAudits int
	if err := pool.QueryRow(ctx, `
		SELECT
			COUNT(*) FILTER (WHERE action = 'invite.create' AND result = 'success'),
			COUNT(*) FILTER (WHERE action = 'invite.revoke' AND result = 'success'),
			COUNT(*) FILTER (WHERE action = 'invite.create' AND result = 'rejected' AND reason = 'insufficient permission')
		FROM audit_logs WHERE actor_user_id = 'invite-admin'
	`).Scan(&createAudits, &revokeAudits, &rejectedAudits); err != nil {
		t.Fatal(err)
	}
	if createAudits != 1 || revokeAudits != 2 || rejectedAudits != 1 {
		t.Fatalf("audit counts = create:%d revoke:%d rejected:%d", createAudits, revokeAudits, rejectedAudits)
	}
}
