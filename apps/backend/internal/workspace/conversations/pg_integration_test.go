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
	// An explicit V2 owner-only DM must not remain in a non-owner's
	// conversation list merely because the old conversation membership exists.
	if _, err := pool.Exec(ctx, `
		INSERT INTO users (id, github_login, display_name, kind, created_at)
		VALUES ('bot_v2_private', '__duallane_v2_private__', 'Private Bot', 'bot', $1)
	`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
		VALUES ($1, 'bot_v2_private', 'member', $2, NULL)
	`, DefaultSpaceID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO workspace_agent_bots (id, space_id, owner_user_id, bot_user_id, mode, name, name_normalized, visibility_policy, conversation_policy, trigger_policy, status, created_at, updated_at)
		VALUES ('bot_v2_private', $1, 'usr_owner', 'bot_v2_private', 'external_agent', 'Private Bot', 'private bot', 'private', 'direct-only', 'mention-or-command', 'active', $2, $2)
	`, DefaultSpaceID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO workspace_agent_bot_settings (bot_id, space_id, visibility_policy, allow_direct, allow_group, access_policy, created_at, updated_at)
		VALUES ('bot_v2_private', $1, 'private', 1, 0, $2::jsonb, $3, $3)
	`, DefaultSpaceID, `{"version":2,"discovery":{"audience":"owner_only"},"direct":{"audience":"owner_only"},"groups":{"audience":"owner_only","allowBotTriggers":false}}`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO conversations (id, space_id, type, title, direct_key, created_by, created_at)
		VALUES ('conv_v2_private', $1, 'direct', 'Private Bot DM', 'v2-private-direct', 'usr_owner', $2)
	`, DefaultSpaceID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at)
		VALUES ('conv_v2_private', 'usr_owner', $1, NULL), ('conv_v2_private', 'usr_direct_target', $1, NULL), ('conv_v2_private', 'bot_v2_private', $1, NULL)
	`, now); err != nil {
		t.Fatal(err)
	}
	conversationRepo := NewPGRepository(pool, idFactory)
	targetConversations, err := conversationRepo.ListConversationRecords(ctx, DefaultSpaceID, "usr_direct_target")
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range targetConversations {
		if item.ID == "conv_v2_private" {
			t.Fatal("V2 owner-only DM leaked to non-owner conversation list")
		}
	}
	ownerConversations, err := conversationRepo.ListConversationRecords(ctx, DefaultSpaceID, "usr_owner")
	if err != nil {
		t.Fatal(err)
	}
	foundOwnerDM := false
	for _, item := range ownerConversations {
		if item.ID == "conv_v2_private" {
			foundOwnerDM = true
			break
		}
	}
	if !foundOwnerDM {
		t.Fatal("V2 owner-only DM missing from owner conversation list")
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
