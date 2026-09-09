//go:build postgres_integration

package conversations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	platformmigrations "github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

func TestPGConversationServiceUsesIsolatedSchemaAndAtomicMutations(t *testing.T) {
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

	schema := fmt.Sprintf("duallane_conversations_%d", time.Now().UnixNano())
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
	runner := platformmigrations.Runner{
		Beginner:  platformpostgres.NewMigrationBeginner(conn),
		Directory: migrationDirectory,
	}
	if _, err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 9, 4, 12, 34, 56, 789000000, time.UTC)
	users := []struct {
		id, login, displayName string
		role                   string
	}{
		{id: "usr_owner", login: "conversation-owner", displayName: "Owner", role: "owner"},
		{id: "usr_direct_target", login: "conversation-direct-target", displayName: "Direct Target", role: "member"},
		{id: "usr_group_target", login: "conversation-group-target", displayName: "Group Target", role: "member"},
		{id: "usr_added_target", login: "conversation-added-target", displayName: "Added Target", role: "member"},
		{id: "usr_rollback_target", login: "conversation-rollback-target", displayName: "Rollback Target", role: "member"},
	}
	for _, user := range users {
		if _, err := conn.Exec(ctx, `INSERT INTO users (id, github_login, display_name, kind, created_at)
			VALUES ($1, $2, $3, 'human', $4)`, user.id, user.login, user.displayName, now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := conn.Exec(ctx, `INSERT INTO spaces (id, name, slug, created_by, created_at)
		VALUES ($1, 'DualLane', 'conversation-integration', $2, $3)`, DefaultSpaceID, "usr_owner", now); err != nil {
		t.Fatal(err)
	}
	for _, user := range users {
		if _, err := conn.Exec(ctx, `INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
			VALUES ($1, $2, $3, $4, NULL)`, DefaultSpaceID, user.id, user.role, now); err != nil {
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
	if err := pool.Ping(ctx); err != nil {
		t.Fatal(err)
	}

	var idSequence atomic.Int64
	idFactory := func() (string, error) {
		return fmt.Sprintf("conversation-integration-%d", idSequence.Add(1)), nil
	}
	service := NewService(ServiceOptions{
		Repository: NewPGRepository(pool, idFactory),
		SpaceID:    DefaultSpaceID,
		Now:        func() time.Time { return now },
		IDFactory:  idFactory,
	})

	assertNoConversationMembership(t, ctx, pool, "usr_direct_target")
	direct, err := service.CreateConversation(ctx, CreateConversationInput{
		ActorID:      "usr_owner",
		Type:         string(ConversationTypeDirect),
		TargetUserID: "usr_direct_target",
		Meta:         auth.RequestMeta{RequestID: "conversation-direct"},
	})
	if err != nil {
		t.Fatalf("create direct conversation: %v", err)
	}
	if direct.Type != string(ConversationTypeDirect) || len(direct.Members) != 2 {
		t.Fatalf("direct conversation = %#v", direct)
	}

	assertNoConversationMembership(t, ctx, pool, "usr_group_target")
	group, err := service.CreateConversation(ctx, CreateConversationInput{
		ActorID:   "usr_owner",
		Type:      string(ConversationTypeGroup),
		Title:     "Integration group",
		MemberIDs: []string{"usr_group_target"},
		Meta:      auth.RequestMeta{RequestID: "conversation-group"},
	})
	if err != nil {
		t.Fatalf("create group conversation: %v", err)
	}
	if group.Type != string(ConversationTypeGroup) || len(group.Members) != 2 {
		t.Fatalf("group conversation = %#v", group)
	}

	assertNoConversationMembership(t, ctx, pool, "usr_added_target")
	if _, err := service.AddMember(ctx, ConversationMemberInput{
		ActorID:        "usr_owner",
		ConversationID: group.ID,
		UserID:         "usr_added_target",
		Meta:           auth.RequestMeta{RequestID: "conversation-member-add"},
	}); err != nil {
		t.Fatalf("add conversation member: %v", err)
	}
	var eventCount, auditCount int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM workspace_events`).Scan(&eventCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM audit_logs`).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if eventCount != 6 || auditCount != 3 {
		t.Fatalf("mutation evidence = events:%d audits:%d, want events:6 audits:3", eventCount, auditCount)
	}
	rows, err := pool.Query(ctx, `SELECT m.plain_text, m.author_kind, m.kind
		FROM messages m
		INNER JOIN workspace_events e ON e.type = 'message.created' AND e.target_id = m.id
		ORDER BY e.seq`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var systemMessages []string
	for rows.Next() {
		var plainText, authorKind, kind string
		if err := rows.Scan(&plainText, &authorKind, &kind); err != nil {
			t.Fatal(err)
		}
		if authorKind != "system" || kind != "system" {
			t.Fatalf("system message kinds = %q/%q", authorKind, kind)
		}
		systemMessages = append(systemMessages, plainText)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	wantSystemMessages := []string{
		"Owner 创建了群聊「Integration group」",
		"Owner 邀请 Added Target 加入群聊",
	}
	if len(systemMessages) != len(wantSystemMessages) {
		t.Fatalf("system messages = %#v, want %#v", systemMessages, wantSystemMessages)
	}
	for index := range wantSystemMessages {
		if systemMessages[index] != wantSystemMessages[index] {
			t.Fatalf("system messages = %#v, want %#v", systemMessages, wantSystemMessages)
		}
	}
	var payloadJSON []byte
	if err := pool.QueryRow(ctx, `SELECT payload_json::text FROM workspace_events
		WHERE type = 'message.created' AND (payload_json::jsonb)->>'conversationId' = $1
		ORDER BY seq DESC LIMIT 1`, group.ID).Scan(&payloadJSON); err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Message struct {
			PlainText  string `json:"plainText"`
			AuthorKind string `json:"authorKind"`
			Kind       string `json:"kind"`
		} `json:"message"`
	}
	if err := json.Unmarshal(payloadJSON, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Message.PlainText != wantSystemMessages[1] || payload.Message.AuthorKind != "system" || payload.Message.Kind != "system" {
		t.Fatalf("system message event payload = %#v", payload.Message)
	}

	var rollbackCalls atomic.Int64
	rollbackFactory := func() (string, error) {
		if rollbackCalls.Add(1) == 1 {
			return "rollback-conversation", nil
		}
		return "", errors.New("event id entropy unavailable")
	}
	rollbackService := NewService(ServiceOptions{
		Repository: NewPGRepository(pool, rollbackFactory),
		SpaceID:    DefaultSpaceID,
		Now:        func() time.Time { return now },
		IDFactory:  rollbackFactory,
	})
	if _, err := rollbackService.CreateConversation(ctx, CreateConversationInput{
		ActorID:   "usr_owner",
		Type:      string(ConversationTypeGroup),
		Title:     "Should roll back",
		MemberIDs: []string{"usr_rollback_target"},
		Meta:      auth.RequestMeta{RequestID: "conversation-rollback"},
	}); !isCode(err, CodeInternal) {
		t.Fatalf("rollback create error = %v, want %s", err, CodeInternal)
	}
	var rollbackConversations, rollbackEvents, rollbackAudits int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM conversations WHERE id = 'rollback-conversation'`).Scan(&rollbackConversations); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM workspace_events WHERE type = 'conversation.created' AND conversation_id = 'rollback-conversation'`).Scan(&rollbackEvents); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM audit_logs WHERE request_id = 'conversation-rollback'`).Scan(&rollbackAudits); err != nil {
		t.Fatal(err)
	}
	if rollbackConversations != 0 || rollbackEvents != 0 || rollbackAudits != 0 {
		t.Fatalf("failed create left state: conversations:%d events:%d audits:%d", rollbackConversations, rollbackEvents, rollbackAudits)
	}
}

func assertNoConversationMembership(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID string) {
	t.Helper()
	var count int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM conversation_members WHERE user_id = $1`, userID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("user %s already has %d conversation memberships", userID, count)
	}
}
