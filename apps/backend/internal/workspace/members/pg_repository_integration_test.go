//go:build postgres_integration

package members

import (
	"context"
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
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

func TestPGMemberLifecycleAndVisibility(t *testing.T) {
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

	schema := fmt.Sprintf("duallane_members_%d", time.Now().UnixNano())
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
	if _, err := (migrations.Runner{Beginner: platformpostgres.NewMigrationBeginner(conn), Directory: migrationDirectory}).Run(ctx); err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 9, 4, 12, 34, 56, 789654321, time.UTC)
	users := []struct {
		id, login, name string
	}{
		{"usr_owner", "owner", "Owner"},
		{"usr_viewer", "viewer", "Viewer"},
		{"usr_target", "target", "Target"},
		{BeaconUserID, "__duallane_beacon__", "信标"},
		{EchoUserID, "__duallane_echo__", "回声"},
	}
	for _, user := range users {
		if _, err := conn.Exec(ctx, `INSERT INTO users (id, github_login, email, display_name, kind, created_at, last_login_at)
			VALUES ($1, $2, $3, $4, $5, $6, $6)`, user.id, user.login, user.id+"@example.test", user.name, map[bool]string{true: "bot", false: "human"}[user.id == BeaconUserID || user.id == EchoUserID], now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := conn.Exec(ctx, `INSERT INTO spaces (id, name, slug, created_by, created_at) VALUES ($1, 'DualLane', 'duallane', $2, $3)`, DefaultSpaceID, "usr_owner", now); err != nil {
		t.Fatal(err)
	}
	for _, member := range []struct{ id, role string }{
		{"usr_owner", RoleOwner}, {"usr_viewer", RoleMember}, {"usr_target", RoleMember}, {BeaconUserID, RoleMember}, {EchoUserID, RoleMember},
	} {
		if _, err := conn.Exec(ctx, `INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at) VALUES ($1, $2, $3, $4, NULL)`, DefaultSpaceID, member.id, member.role, now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := conn.Exec(ctx, `INSERT INTO conversations (id, space_id, type, title, direct_key, created_by, created_at) VALUES ('conv_members', $1, 'direct', 'Members', 'members-direct', 'usr_owner', $2)`, DefaultSpaceID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at) VALUES ('conv_members', 'usr_target', $1, NULL)`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, revoked_at) VALUES ('ses_target', 'target-session-hash', 'usr_target', $1, $2, NULL)`, now, now.Add(time.Hour)); err != nil {
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
	idFactory := func() (string, error) {
		return fmt.Sprintf("member-integration-%d", sequence.Add(1)), nil
	}
	service := NewService(ServiceOptions{Repository: NewPGRepository(pool, idFactory), Now: func() time.Time { return now }, IDFactory: idFactory})

	list, err := service.List(ctx, ListInput{ActorID: "usr_owner", Options: ListOptions{Limit: 500}})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != len(users) {
		t.Fatalf("owner member list length = %d, want %d", len(list), len(users))
	}
	profileNickname := "Owner Alias"
	profileDiscoverable := true
	profileRecallReason := "内容有误"
	if _, err := service.UpdateOwnProfile(ctx, UpdateOwnProfileInput{ActorID: "usr_owner", Nickname: &profileNickname, SearchDiscoverable: &profileDiscoverable, RecallReason: &profileRecallReason, Meta: auth.RequestMeta{RequestID: "pg-profile", IPAddress: "198.51.100.8:443", UserAgent: "pg-test"}}); err != nil {
		t.Fatal(err)
	}
	var storedRecallReason *string
	if err := pool.QueryRow(ctx, `SELECT recall_reason FROM users WHERE id = 'usr_owner'`).Scan(&storedRecallReason); err != nil {
		t.Fatal(err)
	}
	if storedRecallReason == nil || *storedRecallReason != profileRecallReason {
		t.Fatalf("stored recall reason = %v, want %q", storedRecallReason, profileRecallReason)
	}
	clearedProfile, err := service.UpdateOwnProfile(ctx, UpdateOwnProfileInput{ActorID: "usr_owner", RecallReasonSet: true, Meta: auth.RequestMeta{RequestID: "pg-recall-clear"}})
	if err != nil || clearedProfile.RecallReason != "内容有误" {
		t.Fatalf("cleared profile = %#v, err=%v", clearedProfile, err)
	}
	if err := pool.QueryRow(ctx, `SELECT recall_reason FROM users WHERE id = 'usr_owner'`).Scan(&storedRecallReason); err != nil {
		t.Fatal(err)
	}
	if storedRecallReason != nil {
		t.Fatalf("recall reason after clear = %q, want NULL", *storedRecallReason)
	}
	tooLongRecall := strings.Repeat("x", 17)
	if _, err := service.UpdateOwnProfile(ctx, UpdateOwnProfileInput{ActorID: "usr_owner", RecallReason: &tooLongRecall}); err == nil {
		t.Fatal("overlong recall reason unexpectedly accepted")
	} else {
		assertCode(t, err, CodeProfileRecallReasonInvalid)
	}
	var recallAuditCount int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM audit_logs WHERE action = 'profile.recall_reason_update' AND target_id = 'usr_owner'`).Scan(&recallAuditCount); err != nil {
		t.Fatal(err)
	}
	if recallAuditCount != 1 {
		t.Fatalf("recall reason audit count = %d, want 1", recallAuditCount)
	}
	visibility, err := service.UpdateVisibility(ctx, VisibilityInput{ActorID: "usr_owner", ViewerUserID: "usr_viewer", VisibleUserIDs: []string{"usr_target"}, Meta: auth.RequestMeta{RequestID: "pg-visibility"}})
	if err != nil || len(visibility.GrantedUserIDs) != 1 || visibility.GrantedUserIDs[0] != "usr_target" {
		t.Fatalf("visibility = %#v, err=%v", visibility, err)
	}
	member, err := service.UpdateMemberRole(ctx, RoleInput{ActorID: "usr_owner", UserID: "usr_target", Role: RoleAdmin, Meta: auth.RequestMeta{RequestID: "pg-role"}})
	if err != nil || member.Role != RoleAdmin {
		t.Fatalf("role update = %#v, err=%v", member, err)
	}
	removed, err := service.RemoveMember(ctx, RemoveInput{ActorID: "usr_owner", UserID: "usr_target", Meta: auth.RequestMeta{RequestID: "pg-remove"}})
	if err != nil || removed.RemovedAt != "2026-09-04T12:34:56.789Z" {
		t.Fatalf("remove = %#v, err=%v", removed, err)
	}
	var memberRemovedAt, sessionRevokedAt, conversationRemovedAt *time.Time
	if err := pool.QueryRow(ctx, `SELECT removed_at FROM space_members WHERE space_id = $1 AND user_id = 'usr_target'`, DefaultSpaceID).Scan(&memberRemovedAt); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT revoked_at FROM sessions WHERE id = 'ses_target'`).Scan(&sessionRevokedAt); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT removed_at FROM conversation_members WHERE conversation_id = 'conv_members' AND user_id = 'usr_target'`).Scan(&conversationRemovedAt); err != nil {
		t.Fatal(err)
	}
	if memberRemovedAt == nil || sessionRevokedAt == nil || conversationRemovedAt == nil {
		t.Fatalf("removal revocations = member:%v session:%v conversation:%v", memberRemovedAt, sessionRevokedAt, conversationRemovedAt)
	}
	var payload string
	if err := pool.QueryRow(ctx, `SELECT payload_json FROM workspace_events WHERE type = 'workspace.member_updated' AND target_id = 'usr_target' ORDER BY seq DESC LIMIT 1`).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(payload, `"member"`) {
		t.Fatalf("role event omitted member projection: %s", payload)
	}
}
