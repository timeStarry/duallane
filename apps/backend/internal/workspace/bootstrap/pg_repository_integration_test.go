//go:build postgres_integration

package bootstrap

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
	platformmigrations "github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/seed"
)

func TestPGRepositoryFiltersInviteRolesAndDeduplicatesAcceptances(t *testing.T) {
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

	schema := fmt.Sprintf("duallane_bootstrap_%d", time.Now().UnixNano())
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
	runner := platformmigrations.Runner{
		Beginner:  platformpostgres.NewMigrationBeginner(conn),
		Directory: filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../web/server/migrations")),
	}
	if _, err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if err := seed.Run(ctx, conn); err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC)
	if _, err := conn.Exec(ctx, `INSERT INTO users (id, github_login, display_name, kind, created_at)
		VALUES ('accepted-user', 'accepted-user', 'Accepted User', 'human', $1)`, now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `INSERT INTO space_members (space_id, user_id, role, joined_at)
		VALUES ($1, 'accepted-user', 'member', $2)`, DefaultSpaceID, now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct {
		id, role string
		revoked  *time.Time
	}{{"invite-member", "member", nil}, {"invite-owner", "owner", &now}} {
		if _, err := conn.Exec(ctx, `INSERT INTO invites (
			id, space_id, code_hash, code_preview, default_role, created_by, max_uses, uses, expires_at, revoked_at, created_at
		) VALUES ($1, $2, $1, 'PREVIEW', $3, $4, 3, 1, NULL, $5, $6)`,
			row.id, DefaultSpaceID, row.role, seed.SeededOwnerID, row.revoked, now.Add(-2*time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	for index := range 2 {
		if _, err := conn.Exec(ctx, `INSERT INTO audit_logs (
			id, space_id, actor_user_id, action, target_type, target_id, result, created_at
		) VALUES ($1, $2, 'accepted-user', 'invite.accept', 'invite', 'invite-member', 'success', $3)`,
			fmt.Sprintf("acceptance-%d", index), DefaultSpaceID, now.Add(time.Duration(index)*time.Minute)); err != nil {
			t.Fatal(err)
		}
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
	repository := NewPGRepository(pool)

	owner, err := repository.Load(ctx, DefaultSpaceID, "owner", now)
	if err != nil {
		t.Fatal(err)
	}
	if owner.Space.ID != DefaultSpaceID || len(owner.Invites) != 2 || owner.InviteSummary.Total != 2 || owner.InviteSummary.Active != 1 || owner.InviteSummary.History != 1 {
		t.Fatalf("owner snapshot = %#v", owner)
	}
	var memberInvite InviteRecord
	for _, invite := range owner.Invites {
		if invite.ID == "invite-member" {
			memberInvite = invite
		}
	}
	if len(memberInvite.Acceptances) != 1 || memberInvite.Acceptances[0].UserID != "accepted-user" {
		t.Fatalf("deduplicated acceptances = %#v", memberInvite.Acceptances)
	}

	admin, err := repository.Load(ctx, DefaultSpaceID, "admin", now)
	if err != nil {
		t.Fatal(err)
	}
	if len(admin.Invites) != 1 || admin.Invites[0].DefaultRole != "member" || admin.InviteSummary.Total != 1 {
		t.Fatalf("admin snapshot = %#v", admin)
	}
	member, err := repository.Load(ctx, DefaultSpaceID, "member", now)
	if err != nil {
		t.Fatal(err)
	}
	if member.Invites == nil || len(member.Invites) != 0 || member.InviteSummary != (InviteSummary{}) {
		t.Fatalf("member snapshot = %#v", member)
	}
}
