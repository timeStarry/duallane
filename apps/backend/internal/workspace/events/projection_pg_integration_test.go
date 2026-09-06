//go:build postgres_integration

package events

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

func TestPGConversationProjectionCarriesViewerReadState(t *testing.T) {
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
	t.Cleanup(func() { _ = conn.Close(context.Background()) })

	schema := fmt.Sprintf("duallane_events_projection_%d", time.Now().UnixNano())
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
	if _, err := (migrations.Runner{
		Beginner:  platformpostgres.NewMigrationBeginner(conn),
		Directory: migrationDirectory,
	}).Run(ctx); err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 9, 6, 12, 0, 0, 123456789, time.UTC)
	seedEventIntegrationData(t, ctx, conn, now)
	seedUnreadProjectionData(t, ctx, conn, now)

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

	repository := NewPGRepository(pool)
	actor := &auth.Actor{ID: "usr_viewer", Kind: "human", Role: "member"}
	conversationID := "conv-events-unread"

	initial, err := repository.publicConversationPayload(ctx, DefaultSpaceID, actor, conversationID)
	if err != nil {
		t.Fatal(err)
	}
	assertConversationReadState(t, initial, int64(2), nil, nil, nil)

	service := NewService(ServiceOptions{Repository: repository, BatchSize: 100, ReplayLimit: 100})
	initialEvent := replayConversationProjection(t, ctx, service, conversationID)
	assertConversationReadState(t, initialEvent, int64(2), nil, nil, nil)
	assertConversationReadParity(t, initial, initialEvent)

	readAt := now.Add(time.Second).UTC().Truncate(time.Millisecond)
	mustExecEventPG(t, ctx, conn, `
		UPDATE conversation_members
		SET last_read_message_id = $1, last_read_at = $2, last_read_seq = $3
		WHERE conversation_id = $4 AND user_id = $5
	`, "msg-event-system", readAt, int64(6), conversationID, "usr_viewer")

	marked, err := repository.publicConversationPayload(ctx, DefaultSpaceID, actor, conversationID)
	if err != nil {
		t.Fatal(err)
	}
	readAtString := formatTimestamp(readAt)
	assertConversationReadState(t, marked, int64(1), "msg-event-system", readAtString, int64(6))
	markedEvent := replayConversationProjection(t, ctx, service, conversationID)
	assertConversationReadState(t, markedEvent, int64(1), "msg-event-system", readAtString, int64(6))
	assertConversationReadParity(t, marked, markedEvent)

	mustExecEventPG(t, ctx, conn, `
		UPDATE conversation_members
		SET last_read_message_id = $1, last_read_at = $2, last_read_seq = $3
		WHERE conversation_id = $4 AND user_id = $5
	`, "msg-event-owner", now.Add(3*time.Second), int64(8), conversationID, "usr_viewer")
	cleared, err := repository.publicConversationPayload(ctx, DefaultSpaceID, actor, conversationID)
	if err != nil {
		t.Fatal(err)
	}
	assertConversationReadState(t, cleared, int64(0), "msg-event-owner", formatTimestamp(now.Add(3*time.Second)), int64(8))
	clearedEvent := replayConversationProjection(t, ctx, service, conversationID)
	assertConversationReadState(t, clearedEvent, int64(0), "msg-event-owner", formatTimestamp(now.Add(3*time.Second)), int64(8))
	assertConversationReadParity(t, cleared, clearedEvent)

	var durableID string
	var durableSeq int64
	if err := conn.QueryRow(ctx, `
		SELECT last_read_message_id, last_read_seq
		FROM conversation_members WHERE conversation_id = $1 AND user_id = $2
	`, conversationID, "usr_viewer").Scan(&durableID, &durableSeq); err != nil {
		t.Fatal(err)
	}
	if durableID != "msg-event-owner" || durableSeq != 8 {
		t.Fatalf("durable marker = (%q, %d), want owner message and seq 8", durableID, durableSeq)
	}
}

func seedUnreadProjectionData(t *testing.T, ctx context.Context, conn *pgx.Conn, now time.Time) {
	t.Helper()
	conversationID := "conv-events-unread"
	mustExecEventPG(t, ctx, conn, `
		INSERT INTO conversations (id, space_id, type, title, created_by, created_at)
		VALUES ($1, $2, 'group', 'Unread projection', 'usr_owner', $3)
	`, conversationID, DefaultSpaceID, now)
	for _, userID := range []string{"usr_viewer", "usr_owner"} {
		mustExecEventPG(t, ctx, conn, `
			INSERT INTO conversation_members (conversation_id, user_id, joined_at)
			VALUES ($1, $2, $3)
		`, conversationID, userID, now)
	}
	content := func(text string) string {
		return fmt.Sprintf(`{"format":"duallane.message+json;v=1","plainText":%q,"blocks":[{"type":"text","text":%q}]}`, text, text)
	}
	mustExecEventPG(t, ctx, conn, `
		INSERT INTO messages (
			id, space_id, conversation_id, author_id, author_kind, kind,
			client_message_id, content_format, content_json, plain_text, created_at
		) VALUES ($1, $2, $3, NULL, 'system', 'system', $4, 'duallane.message+json;v=1', $5, $6, $7)
	`, "msg-event-system", DefaultSpaceID, conversationID, "client-event-system", content("system"), "system", now.Add(time.Second))
	mustExecEventPG(t, ctx, conn, `
		INSERT INTO messages (
			id, space_id, conversation_id, author_id, author_kind, kind,
			client_message_id, content_format, content_json, plain_text, created_at
		) VALUES ($1, $2, $3, $4, 'human', 'user', $5, 'duallane.message+json;v=1', $6, $7, $8)
	`, "msg-event-own", DefaultSpaceID, conversationID, "usr_viewer", "client-event-own", content("own"), "own", now.Add(2*time.Second))
	mustExecEventPG(t, ctx, conn, `
		INSERT INTO messages (
			id, space_id, conversation_id, author_id, author_kind, kind,
			client_message_id, content_format, content_json, plain_text, created_at
		) VALUES ($1, $2, $3, $4, 'human', 'user', $5, 'duallane.message+json;v=1', $6, $7, $8)
	`, "msg-event-owner", DefaultSpaceID, conversationID, "usr_owner", "client-event-owner", content("owner"), "owner", now.Add(3*time.Second))
	for _, event := range []struct {
		id, targetID, payload string
		seq                   int64
		createdAt             time.Time
	}{
		{"evt-unread-system", "msg-event-system", `{"messageId":"msg-event-system","conversationId":"conv-events-unread"}`, 6, now.Add(time.Second)},
		{"evt-unread-own", "msg-event-own", `{"messageId":"msg-event-own","conversationId":"conv-events-unread"}`, 7, now.Add(2 * time.Second)},
		{"evt-unread-owner", "msg-event-owner", `{"messageId":"msg-event-owner","conversationId":"conv-events-unread"}`, 8, now.Add(3 * time.Second)},
	} {
		mustExecEventPG(t, ctx, conn, `
			INSERT INTO workspace_events (
				id, space_id, seq, type, actor_user_id, conversation_id,
				target_type, target_id, payload_json, created_at
			) VALUES ($1, $2, $3, 'message.created', 'usr_owner', $4, 'message', $5, $6, $7)
		`, event.id, DefaultSpaceID, event.seq, conversationID, event.targetID, event.payload, event.createdAt)
	}
	mustExecEventPG(t, ctx, conn, `
		INSERT INTO workspace_events (
			id, space_id, seq, type, actor_user_id, conversation_id,
			target_type, target_id, payload_json, created_at
		) VALUES ($1, $2, $3, 'conversation.updated', 'usr_owner', $4, 'conversation', $4, $5, $6)
	`, "evt-unread-conversation", DefaultSpaceID, int64(9), conversationID,
		`{"conversationId":"conv-events-unread"}`, now.Add(4*time.Second))
}

func replayConversationProjection(t *testing.T, ctx context.Context, service *Service, conversationID string) map[string]any {
	t.Helper()
	result, err := service.Replay(ctx, ReplayInput{ActorID: "usr_viewer", Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range result.Events {
		if event.Type != "conversation.updated" {
			continue
		}
		if event.ConversationID == nil || *event.ConversationID != conversationID {
			continue
		}
		conversation, ok := event.Payload["conversation"].(map[string]any)
		if !ok {
			t.Fatalf("conversation event payload = %#v", event.Payload)
		}
		return conversation
	}
	t.Fatalf("conversation.updated event for %s not found in %#v", conversationID, result.Events)
	return nil
}

func assertConversationReadState(t *testing.T, conversation map[string]any, wantUnread int64, wantMessageID, wantReadAt, wantSeq any) {
	t.Helper()
	if got := conversation["unreadCount"]; got != wantUnread {
		t.Fatalf("unreadCount = %#v, want %#v; conversation=%#v", got, wantUnread, conversation)
	}
	for key, want := range map[string]any{
		"lastReadMessageId": wantMessageID,
		"lastReadAt":        wantReadAt,
		"lastReadSeq":       wantSeq,
	} {
		if got := conversation[key]; !reflect.DeepEqual(got, want) {
			t.Fatalf("%s = %#v, want %#v; conversation=%#v", key, got, want, conversation)
		}
	}
}

func assertConversationReadParity(t *testing.T, snapshot, event map[string]any) {
	t.Helper()
	for _, key := range []string{"unreadCount", "lastReadMessageId", "lastReadAt", "lastReadSeq"} {
		if !reflect.DeepEqual(snapshot[key], event[key]) {
			t.Fatalf("snapshot/event %s mismatch: snapshot=%#v event=%#v", key, snapshot[key], event[key])
		}
	}
}
