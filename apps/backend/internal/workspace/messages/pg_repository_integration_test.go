//go:build postgres_integration

package messages

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
)

type pgMessageIntegrationFixture struct {
	ctx     context.Context
	pool    *pgxpool.Pool
	service *Service
	now     time.Time
}

func newPGMessageIntegrationFixture(t *testing.T) *pgMessageIntegrationFixture {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(context.Background()) })

	schema := fmt.Sprintf("duallane_messages_%d", time.Now().UnixNano())
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

	now := time.Date(2026, 9, 4, 12, 34, 56, 789654321, time.UTC)
	seedPGMessageIntegrationData(t, ctx, conn, now)

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

	var idSequence atomic.Int64
	idFactory := func() (string, error) {
		return fmt.Sprintf("message-integration-%06d", idSequence.Add(1)), nil
	}
	repository := NewPGRepository(pool, idFactory)
	return &pgMessageIntegrationFixture{
		ctx:  ctx,
		pool: pool,
		service: NewService(ServiceOptions{
			Repository:             repository,
			SpaceID:                DefaultSpaceID,
			Now:                    func() time.Time { return now },
			IDFactory:              idFactory,
			ReactionEmoteValidator: testReactionValidator{},
		}),
		now: now,
	}
}

func seedPGMessageIntegrationData(t *testing.T, ctx context.Context, conn *pgx.Conn, now time.Time) {
	t.Helper()
	users := []struct {
		id, login, email, name, nickname, recallReason string
	}{
		{"usr-alice", "alice", "alice@example.test", "Alice", "Alice", "test reason"},
		{"usr-bob", "bob", "bob@example.test", "Bob", "Bob", ""},
	}
	for _, user := range users {
		mustExecPGMessageIntegration(t, ctx, conn, `
			INSERT INTO users (
				id, github_login, email, display_name, nickname, recall_reason,
				kind, created_at, last_login_at
			)
			VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), 'human', $7, $7)
		`, user.id, user.login, user.email, user.name, user.nickname, user.recallReason, now)
	}
	mustExecPGMessageIntegration(t, ctx, conn, `
		INSERT INTO spaces (id, name, slug, created_by, created_at)
		VALUES ($1, 'Integration Space', 'messages-integration', 'usr-alice', $2)
	`, DefaultSpaceID, now)
	for _, member := range []struct{ id, role string }{
		{"usr-alice", "owner"},
		{"usr-bob", "member"},
	} {
		mustExecPGMessageIntegration(t, ctx, conn, `
			INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
			VALUES ($1, $2, $3, $4, NULL)
		`, DefaultSpaceID, member.id, member.role, now)
	}
	mustExecPGMessageIntegration(t, ctx, conn, `
		INSERT INTO conversations (
			id, space_id, type, title, direct_key, retention_count, created_by, created_at
		)
		VALUES ('conv-messages', $1, 'direct', 'Messages integration', 'messages-integration', 10000, 'usr-alice', $2)
	`, DefaultSpaceID, now)
	for _, userID := range []string{"usr-alice", "usr-bob"} {
		mustExecPGMessageIntegration(t, ctx, conn, `
			INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at)
			VALUES ('conv-messages', $1, $2, NULL)
		`, userID, now)
	}
}

func mustExecPGMessageIntegration(t *testing.T, ctx context.Context, conn *pgx.Conn, query string, args ...any) {
	t.Helper()
	if _, err := conn.Exec(ctx, query, args...); err != nil {
		t.Fatal(err)
	}
}

func createPGIntegrationMessage(t *testing.T, fixture *pgMessageIntegrationFixture, clientID, text string) Message {
	t.Helper()
	message, err := fixture.service.CreateMessage(fixture.ctx, CreateInput{
		ActorID:         "usr-alice",
		ConversationID:  "conv-messages",
		ClientMessageID: clientID,
		Content: Content{
			Format:    MessageContentFormat,
			PlainText: "client supplied text is ignored",
			Blocks:    []Block{{Type: "text", Text: text}},
		},
	})
	if err != nil {
		t.Fatalf("create %s: %v", clientID, err)
	}
	return message
}

func pgMessageIntegrationCount(t *testing.T, ctx context.Context, pool *pgxpool.Pool, query string, args ...any) int64 {
	t.Helper()
	var count int64
	if err := pool.QueryRow(ctx, query, args...).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestPGMessageLifecycleAndPersistence(t *testing.T) {
	fixture := newPGMessageIntegrationFixture(t)
	first := createPGIntegrationMessage(t, fixture, "client-first", "secret body")
	if first.CreatedAt != "2026-09-04T12:34:56.789Z" || first.PlainText != "secret body" {
		t.Fatalf("created projection = %#v", first)
	}
	if len(first.Content.Blocks) != 1 || first.Content.Blocks[0].Text != "secret body" {
		t.Fatalf("created content = %#v", first.Content)
	}

	createdEvents := pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `
		SELECT COUNT(*) FROM workspace_events
		WHERE type = 'message.created' AND target_id = $1
	`, first.ID)
	createAudits := pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `
		SELECT COUNT(*) FROM audit_logs
		WHERE action = 'message.create' AND target_id = 'conv-messages'
		  AND result = 'success'
	`)
	if createdEvents != 1 || createAudits != 1 {
		t.Fatalf("create evidence = events:%d audits:%d", createdEvents, createAudits)
	}

	replayInput := CreateInput{
		ActorID:         "usr-alice",
		ConversationID:  "conv-messages",
		ClientMessageID: "client-first",
		Content: Content{
			Format:    MessageContentFormat,
			PlainText: "different client projection",
			Blocks:    []Block{{Type: "text", Text: "secret body"}},
		},
	}
	replayed, err := fixture.service.CreateMessage(fixture.ctx, replayInput)
	if err != nil || replayed.ID != first.ID {
		t.Fatalf("matching retry = %#v, err=%v", replayed, err)
	}
	if got := pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `
		SELECT COUNT(*) FROM workspace_events
		WHERE type = 'message.created' AND target_id = $1
	`, first.ID); got != createdEvents {
		t.Fatalf("retry created events = %d, want %d", got, createdEvents)
	}
	if got := pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `
		SELECT COUNT(*) FROM audit_logs
		WHERE action = 'message.create' AND target_id = 'conv-messages'
		  AND result = 'success'
	`); got != createAudits {
		t.Fatalf("retry success audits = %d, want %d", got, createAudits)
	}

	replayInput.Content.Blocks = []Block{{Type: "text", Text: "different body"}}
	if _, err := fixture.service.CreateMessage(fixture.ctx, replayInput); !isMessageCode(err, CodeMessageIdempotency) {
		t.Fatalf("idempotency conflict = %v", err)
	}
	if got := pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `
		SELECT COUNT(*) FROM audit_logs
		WHERE action = 'message.create' AND target_id = 'conv-messages'
		  AND result = 'rejected' AND reason = $1
	`, CodeMessageIdempotency); got != 1 {
		t.Fatalf("idempotency rejection audits = %d, want 1", got)
	}

	second := createPGIntegrationMessage(t, fixture, "client-second", "second body")
	third := createPGIntegrationMessage(t, fixture, "client-third", "third body")
	fourth := createPGIntegrationMessage(t, fixture, "client-fourth", "fourth body")
	latest, err := fixture.service.ListMessages(fixture.ctx, ListOptions{
		ActorID: "usr-alice", ConversationID: "conv-messages", Limit: 2,
	})
	if err != nil || messageIDs(latest) != third.ID+","+fourth.ID {
		t.Fatalf("latest = %s, err=%v", messageIDs(latest), err)
	}
	older, err := fixture.service.ListMessages(fixture.ctx, ListOptions{
		ActorID: "usr-alice", ConversationID: "conv-messages", Before: third.ID, Limit: 1,
	})
	if err != nil || messageIDs(older) != second.ID {
		t.Fatalf("before = %s, err=%v", messageIDs(older), err)
	}
	newer, err := fixture.service.ListMessages(fixture.ctx, ListOptions{
		ActorID: "usr-alice", ConversationID: "conv-messages", After: second.ID, Limit: 2,
	})
	if err != nil || messageIDs(newer) != third.ID+","+fourth.ID {
		t.Fatalf("after = %s, err=%v", messageIDs(newer), err)
	}
	around, err := fixture.service.ListMessages(fixture.ctx, ListOptions{
		ActorID: "usr-alice", ConversationID: "conv-messages", Around: third.ID, Limit: 3,
	})
	if err != nil || messageIDs(around) != second.ID+","+third.ID+","+fourth.ID {
		t.Fatalf("around = %s, err=%v", messageIDs(around), err)
	}

	hidden, err := fixture.service.HideMessage(fixture.ctx, HideInput{ActorID: "usr-bob", MessageID: second.ID})
	if err != nil || !hidden.Hidden || !hidden.Changed {
		t.Fatalf("hide = %#v, err=%v", hidden, err)
	}
	if got := pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `
		SELECT COUNT(*) FROM message_hidden_states WHERE user_id = 'usr-bob' AND message_id = $1
	`, second.ID); got != 1 {
		t.Fatalf("hidden rows = %d, want 1", got)
	}
	hidden, err = fixture.service.HideMessage(fixture.ctx, HideInput{ActorID: "usr-bob", MessageID: second.ID})
	if err != nil || hidden.Changed {
		t.Fatalf("idempotent hide = %#v, err=%v", hidden, err)
	}
	unhidden, err := fixture.service.UnhideMessage(fixture.ctx, HideInput{ActorID: "usr-bob", MessageID: second.ID})
	if err != nil || unhidden.Hidden || !unhidden.Changed {
		t.Fatalf("unhide = %#v, err=%v", unhidden, err)
	}
	if got := pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `
		SELECT COUNT(*) FROM message_hidden_states WHERE user_id = 'usr-bob' AND message_id = $1
	`, second.ID); got != 0 {
		t.Fatalf("hidden rows after unhide = %d, want 0", got)
	}

	added, err := fixture.service.AddReaction(fixture.ctx, ReactionInput{
		ActorID: "usr-bob", MessageID: first.ID, EmoteKey: "builtin:heart",
	})
	if err != nil || !added.Created || len(added.Reactions) != 1 {
		t.Fatalf("reaction add = %#v, err=%v", added, err)
	}
	added, err = fixture.service.AddReaction(fixture.ctx, ReactionInput{
		ActorID: "usr-bob", MessageID: first.ID, EmoteKey: "builtin:heart",
	})
	if err != nil || added.Created {
		t.Fatalf("idempotent reaction add = %#v, err=%v", added, err)
	}
	removed, err := fixture.service.RemoveReaction(fixture.ctx, ReactionInput{
		ActorID: "usr-bob", MessageID: first.ID, EmoteKey: "builtin:heart",
	})
	if err != nil || !removed.Removed || len(removed.Reactions) != 0 {
		t.Fatalf("reaction remove = %#v, err=%v", removed, err)
	}
	removed, err = fixture.service.RemoveReaction(fixture.ctx, ReactionInput{
		ActorID: "usr-bob", MessageID: first.ID, EmoteKey: "builtin:heart",
	})
	if err != nil || removed.Removed {
		t.Fatalf("idempotent reaction remove = %#v, err=%v", removed, err)
	}
	_, err = fixture.service.AddReaction(fixture.ctx, ReactionInput{
		ActorID: "usr-bob", MessageID: first.ID, EmoteKey: "builtin:heart",
	})
	if err != nil {
		t.Fatalf("reaction restore: %v", err)
	}
	if got := pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `
		SELECT COUNT(*) FROM message_reactions WHERE message_id = $1
	`, first.ID); got != 1 {
		t.Fatalf("reaction rows before recall = %d, want 1", got)
	}

	seedPGMessageRecallRelations(t, fixture, first.ID)
	recalled, err := fixture.service.RecallMessage(fixture.ctx, RecallInput{
		ActorID: "usr-alice", MessageID: first.ID, ExpectedRevision: 1,
	})
	if err != nil {
		t.Fatalf("recall: %v", err)
	}
	if recalled.RecalledAt == nil || recalled.RecallReason == nil || *recalled.RecallReason != "test reason" {
		t.Fatalf("recalled projection = %#v", recalled)
	}
	if strings.Contains(recalled.PlainText, "secret body") || len(recalled.Content.Blocks) != 0 {
		t.Fatalf("recalled projection leaked content = %#v", recalled)
	}

	var contentJSON, plainText string
	var recalledAt, recallReason *string
	if err := fixture.pool.QueryRow(fixture.ctx, `
		SELECT content_json, plain_text, recalled_at::text, recall_reason
		FROM messages WHERE id = $1
	`, first.ID).Scan(&contentJSON, &plainText, &recalledAt, &recallReason); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(contentJSON, "secret body") || strings.Contains(plainText, "secret body") || recalledAt == nil || recallReason == nil {
		t.Fatalf("stored recall state = content:%s plain:%s at:%v reason:%v", contentJSON, plainText, recalledAt, recallReason)
	}
	if got := pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `
		SELECT COUNT(*) FROM message_reactions WHERE message_id = $1
	`, first.ID); got != 0 {
		t.Fatalf("reaction rows after recall = %d, want 0", got)
	}
	if got := pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `
		SELECT COUNT(*) FROM message_custom_emotes WHERE message_id = $1
	`, first.ID); got != 0 {
		t.Fatalf("custom emote rows after recall = %d, want 0", got)
	}
	if got := pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `
		SELECT COUNT(*) FROM message_emote_collection_shares WHERE message_id = $1
	`, first.ID); got != 0 {
		t.Fatalf("emote share rows after recall = %d, want 0", got)
	}
	if got := pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `
		SELECT COUNT(*) FROM conversation_pinned_messages WHERE message_id = $1
	`, first.ID); got != 0 {
		t.Fatalf("pin rows after recall = %d, want 0", got)
	}
	var pinCount int
	if err := fixture.pool.QueryRow(fixture.ctx, `
		SELECT pin_count FROM conversation_pin_counters
		WHERE conversation_id = 'conv-messages' AND user_id = 'usr-bob'
	`).Scan(&pinCount); err != nil {
		t.Fatal(err)
	}
	if pinCount != 0 {
		t.Fatalf("pin counter after recall = %d, want 0", pinCount)
	}

	var recallPayload string
	if got := pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `
		SELECT COUNT(*) FROM workspace_events
		WHERE type = 'message.recalled' AND target_id = $1
	`, first.ID); got != 1 {
		t.Fatalf("recall events = %d, want 1", got)
	}
	if err := fixture.pool.QueryRow(fixture.ctx, `
		SELECT payload_json FROM workspace_events
		WHERE type = 'message.recalled' AND target_id = $1
	`, first.ID).Scan(&recallPayload); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(recallPayload, "secret body") {
		t.Fatalf("recall event leaked content: %s", recallPayload)
	}
	var recallAuditResult string
	var recallAuditReason *string
	if err := fixture.pool.QueryRow(fixture.ctx, `
		SELECT result, reason FROM audit_logs
		WHERE action = 'message.recall' AND target_id = $1
	`, first.ID).Scan(&recallAuditResult, &recallAuditReason); err != nil {
		t.Fatal(err)
	}
	if recallAuditResult != "success" || recallAuditReason != nil {
		t.Fatalf("recall audit = result:%s reason:%v", recallAuditResult, recallAuditReason)
	}

	if _, err := fixture.service.RecallMessage(fixture.ctx, RecallInput{
		ActorID: "usr-alice", MessageID: first.ID, ExpectedRevision: 1,
	}); err != nil {
		t.Fatalf("idempotent recall: %v", err)
	}
	if got := pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `
		SELECT COUNT(*) FROM workspace_events
		WHERE type = 'message.recalled' AND target_id = $1
	`, first.ID); got != 1 {
		t.Fatalf("repeated recall events = %d, want 1", got)
	}
	if got := pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `
		SELECT COUNT(*) FROM audit_logs
		WHERE action = 'message.recall' AND target_id = $1
	`, first.ID); got != 1 {
		t.Fatalf("repeated recall audits = %d, want 1", got)
	}
}

func seedPGMessageRecallRelations(t *testing.T, fixture *pgMessageIntegrationFixture, messageID string) {
	t.Helper()
	mustExecPGMessageIntegrationPool(t, fixture, `
		INSERT INTO workspace_custom_emotes (
			id, user_id, source_type, source_emote_key, label, sort_order, created_at
		)
		VALUES ('custom-emote-1', 'usr-bob', 'builtin', 'builtin:wave', 'Wave', 0, $1)
	`, fixture.now)
	mustExecPGMessageIntegrationPool(t, fixture, `
		INSERT INTO workspace_emote_collection_shares (
			id, collection_id, shared_by_user_id, original_creator_user_id,
			snapshot_name, fingerprint, item_count, created_at, revoked_at
		)
		VALUES ('share-1', NULL, 'usr-bob', 'usr-bob', 'Shared', 'fingerprint-1', 1, $1, NULL)
	`, fixture.now)
	mustExecPGMessageIntegrationPool(t, fixture, `
		INSERT INTO message_custom_emotes (message_id, custom_emote_id)
		VALUES ($1, 'custom-emote-1')
	`, messageID)
	mustExecPGMessageIntegrationPool(t, fixture, `
		INSERT INTO message_emote_collection_shares (message_id, share_id)
		VALUES ($1, 'share-1')
	`, messageID)
	mustExecPGMessageIntegrationPool(t, fixture, `
		INSERT INTO conversation_pinned_messages (
			conversation_id, message_id, pinned_by_user_id, created_at
		)
		VALUES ('conv-messages', $1, 'usr-bob', $2)
	`, messageID, fixture.now)
	mustExecPGMessageIntegrationPool(t, fixture, `
		INSERT INTO conversation_pin_counters (conversation_id, user_id, pin_count)
		VALUES ('conv-messages', 'usr-bob', 1)
	`)
}

func mustExecPGMessageIntegrationPool(t *testing.T, fixture *pgMessageIntegrationFixture, query string, args ...any) {
	t.Helper()
	if _, err := fixture.pool.Exec(fixture.ctx, query, args...); err != nil {
		t.Fatal(err)
	}
}
