//go:build postgres_integration

package auth

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
)

func TestPGStoreAuthenticationAndSessionLifecycle(t *testing.T) {
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

	schema := fmt.Sprintf("duallane_auth_%d", time.Now().UnixNano())
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
	runner := migrations.Runner{
		Beginner:  platformpostgres.NewMigrationBeginner(conn),
		Directory: migrationDirectory,
	}
	if _, err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}

	seededAt := time.Now().UTC()
	if _, err := conn.Exec(ctx, `
		INSERT INTO users (id, github_login, email, display_name, kind, created_at, last_login_at)
		VALUES ($1, $2, $3, $4, 'human', $5, $5)
	`, SeededOwnerID, SeededOwnerGitHubLogin, SeededOwnerEmail, SeededOwnerGitHubLogin, seededAt); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO spaces (id, name, slug, created_by, created_at)
		VALUES ($1, 'DualLane', 'duallane', $2, $3)
	`, DefaultSpaceID, SeededOwnerID, seededAt); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
		VALUES ($1, $2, 'owner', $3, NULL)
	`, DefaultSpaceID, SeededOwnerID, seededAt); err != nil {
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

	var idSequence atomic.Int64
	idFactory := func() (string, error) {
		return fmt.Sprintf("auth-integration-%d", idSequence.Add(1)), nil
	}
	fixedNow := time.Date(2026, 9, 4, 12, 34, 56, 789_000_000, time.UTC)
	store := NewPGStore(pool, idFactory)
	service := NewService(ServiceOptions{
		Store:      store,
		Now:        func() time.Time { return fixedNow },
		IDFactory:  idFactory,
		SessionTTL: time.Hour,
	})
	if err := service.RecordInviteAcceptRejection(ctx, CodeGitHubRequired, RequestMeta{RequestID: "invite-github-required", IPAddress: "203.0.113.9"}); err != nil {
		t.Fatal(err)
	}
	var rejectionReason, rejectionTargetID string
	if err := pool.QueryRow(ctx, `SELECT reason, COALESCE(target_id, '') FROM audit_logs
		WHERE request_id = 'invite-github-required' AND action = 'invite.accept'`).Scan(&rejectionReason, &rejectionTargetID); err != nil {
		t.Fatal(err)
	}
	if rejectionReason != CodeGitHubRequired || rejectionTargetID != "" {
		t.Fatalf("production invite rejection = reason:%q target:%q", rejectionReason, rejectionTargetID)
	}

	owner, err := service.AuthenticateGitHub(ctx, GitHubProfile{
		ID:    "1001",
		Login: SeededOwnerGitHubLogin,
		Email: SeededOwnerEmail,
		Name:  "Owner",
	}, "", RequestMeta{RequestID: "owner-login", IPAddress: "127.0.0.1", UserAgent: "integration"})
	if err != nil {
		t.Fatal(err)
	}
	if owner.ID != SeededOwnerID || owner.Role != "owner" {
		t.Fatalf("owner = %#v", owner)
	}

	session, err := service.CreateSession(ctx, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	var storedHash string
	if err := pool.QueryRow(ctx, "SELECT token_hash FROM sessions WHERE id = $1", session.ID).Scan(&storedHash); err != nil {
		t.Fatal(err)
	}
	if storedHash != HashSecret(session.Token) || storedHash == session.Token {
		t.Fatal("session persistence did not retain only the token hash")
	}
	if resolved, err := service.ResolveActor(ctx, session.Token); err != nil || resolved.ID != owner.ID {
		t.Fatalf("resolve session actor: actor=%#v err=%v", resolved, err)
	}
	if revoked, err := service.RevokeSession(ctx, session.Token); err != nil || !revoked {
		t.Fatalf("revoke session: revoked=%v err=%v", revoked, err)
	}
	if _, err := service.ResolveActor(ctx, session.Token); !isCode(err, CodeRequired) {
		t.Fatalf("resolve revoked session error = %v", err)
	}

	inviteCode := "DL-INTEGRATION-INVITE"
	if _, err := pool.Exec(ctx, `
		INSERT INTO invites (
			id, space_id, code_hash, code_preview, default_role, created_by,
			max_uses, uses, expires_at, revoked_at, created_at
		)
		VALUES ('invite-integration', $1, $2, 'DL-I...', 'member', $3, 1, 0, $4, NULL, $5)
	`, DefaultSpaceID, HashSecret(inviteCode), owner.ID, fixedNow.Add(time.Hour), fixedNow); err != nil {
		t.Fatal(err)
	}

	member, err := service.AuthenticateGitHub(ctx, GitHubProfile{
		ID:    "2002",
		Login: "invited-member",
		Email: "member@example.com",
		Name:  "Invited Member",
	}, inviteCode, RequestMeta{RequestID: "invite-success"})
	if err != nil {
		t.Fatal(err)
	}
	if member.Role != "member" || member.Kind != "human" {
		t.Fatalf("member = %#v", member)
	}

	var uses int
	if err := pool.QueryRow(ctx, "SELECT uses FROM invites WHERE id = 'invite-integration'").Scan(&uses); err != nil {
		t.Fatal(err)
	}
	if uses != 1 {
		t.Fatalf("invite uses = %d, want 1", uses)
	}
	var eventPayload string
	if err := pool.QueryRow(ctx, `
		SELECT payload_json FROM workspace_events
		WHERE type = 'workspace.member_joined' AND target_id = $1
	`, member.ID).Scan(&eventPayload); err != nil {
		t.Fatal(err)
	}
	if eventPayload == "" {
		t.Fatal("member joined event payload is empty")
	}
	var loginRejected, inviteAccepted int
	if err := pool.QueryRow(ctx, `
		SELECT
			COUNT(*) FILTER (WHERE action = 'login.rejected' AND reason = 'not invited'),
			COUNT(*) FILTER (WHERE action = 'invite.accept' AND result = 'success')
		FROM audit_logs WHERE request_id = 'invite-success'
	`).Scan(&loginRejected, &inviteAccepted); err != nil {
		t.Fatal(err)
	}
	if loginRejected != 1 || inviteAccepted != 1 {
		t.Fatalf("successful invite audit counts = rejected:%d accepted:%d", loginRejected, inviteAccepted)
	}

	_, err = service.AuthenticateGitHub(ctx, GitHubProfile{
		ID: "3003", Login: "second-member", Email: "second@example.com",
	}, inviteCode, RequestMeta{RequestID: "invite-exhausted"})
	if !isCode(err, CodeInviteExhausted) {
		t.Fatalf("exhausted invite error = %v", err)
	}
	var auditReason string
	if err := pool.QueryRow(ctx, `
		SELECT reason FROM audit_logs
		WHERE request_id = 'invite-exhausted' AND action = 'invite.accept'
		ORDER BY created_at DESC, id DESC LIMIT 1
	`).Scan(&auditReason); err != nil {
		t.Fatal(err)
	}
	if auditReason != "invite exhausted" {
		t.Fatalf("exhausted invite audit reason = %q", auditReason)
	}
}
