//go:build postgres_integration

package events

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
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

func TestPGEventReplayVisibilityAndWindow(t *testing.T) {
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

	schema := fmt.Sprintf("duallane_events_%d", time.Now().UnixNano())
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

	now := time.Date(2026, 9, 4, 12, 34, 56, 789654321, time.UTC)
	seedEventIntegrationData(t, ctx, conn, now)
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
	t.Run("reaction events hydrate current viewer state", func(t *testing.T) {
		assertReactionEventProjection(t, ctx, repository)
	})
	beaconConversation := &auth.Actor{ID: "usr_viewer", Kind: "human", Role: "member"}
	projectedConversation, err := repository.publicConversationPayload(ctx, DefaultSpaceID, beaconConversation, "conv-events-beacon")
	if err != nil {
		t.Fatal(err)
	}
	if projectedConversation == nil {
		t.Fatal("beacon conversation was not projected")
	}
	peer, ok := projectedConversation["otherMember"].(map[string]any)
	if !ok {
		t.Fatalf("direct otherMember = %#v", projectedConversation["otherMember"])
	}
	if peer["id"] != "usr_system_beacon" || peer["kind"] != "bot" || peer["description"] != "文件传输助手" {
		t.Fatalf("direct bot peer projection = %#v", peer)
	}
	if projectedConversation["displayTitle"] != "信标" {
		t.Fatalf("direct displayTitle = %#v", projectedConversation["displayTitle"])
	}
	safeEventPayload := projectPayload("conversation.created", map[string]any{
		"conversation": projectedConversation,
	}, beaconConversation)
	safeConversationPayload, ok := safeEventPayload["conversation"].(map[string]any)
	if !ok {
		t.Fatalf("safe event conversation = %#v", safeEventPayload["conversation"])
	}
	safePeer, ok := safeConversationPayload["otherMember"].(map[string]any)
	if !ok || safePeer["kind"] != "bot" || safePeer["description"] != "文件传输助手" {
		t.Fatalf("safe event bot peer projection = %#v", safeConversationPayload["otherMember"])
	}

	service := NewService(ServiceOptions{Repository: repository, BatchSize: 2, ReplayLimit: 2})
	viewer, err := service.Replay(ctx, ReplayInput{ActorID: "usr_viewer"})
	if err != nil {
		t.Fatal(err)
	}
	if got := eventSeqs(viewer.Events); len(got) != 2 || got[0] != 1 || got[1] != 2 || !viewer.HasMore {
		t.Fatalf("viewer replay = seq:%v metadata:%#v", got, viewer)
	}
	if viewer.Events[0].CreatedAt != "2026-09-04T12:34:56.789Z" {
		t.Fatalf("event timestamp = %q", viewer.Events[0].CreatedAt)
	}
	if _, leaked := viewer.Events[0].Payload["email"]; leaked {
		t.Fatal("event payload leaked private identity")
	}
	message, ok := viewer.Events[1].Payload["message"].(map[string]any)
	if !ok {
		t.Fatalf("message event payload = %#v", viewer.Events[1].Payload)
	}
	if message["hiddenByCurrentUser"] != true {
		t.Fatalf("message hidden state = %#v", message["hiddenByCurrentUser"])
	}
	reactions, ok := message["reactions"].([]any)
	if !ok || len(reactions) != 1 {
		t.Fatalf("message reactions = %#v", message["reactions"])
	}
	reaction := reactions[0].(map[string]any)
	if reaction["count"] != int64(2) || reaction["reactedByCurrentUser"] != true {
		t.Fatalf("current reaction projection = %#v", reaction)
	}
	attachments, ok := message["attachments"].([]any)
	if !ok || len(attachments) != 1 {
		t.Fatalf("message attachments = %#v", message["attachments"])
	}
	attachment := attachments[0].(map[string]any)
	capabilities := attachment["capabilities"].(map[string]any)
	if capabilities["canDownload"] != true || capabilities["canRemove"] != false {
		t.Fatalf("viewer attachment capabilities = %#v", capabilities)
	}
	pin := message["pin"].(map[string]any)
	if pin["canUnpin"] != false {
		t.Fatalf("viewer pin capabilities = %#v", pin)
	}

	topicReplay, err := ownerServiceFor(repository).Replay(ctx, ReplayInput{ActorID: "usr_viewer", LastSeq: 3})
	if err != nil {
		t.Fatal(err)
	}
	if got := eventSeqs(topicReplay.Events); len(got) != 1 || got[0] != 4 {
		t.Fatalf("non-topic member topic replay = %v", got)
	}

	outsider, err := service.Replay(ctx, ReplayInput{ActorID: "usr_outsider"})
	if err != nil {
		t.Fatal(err)
	}
	if len(outsider.Events) != 0 {
		t.Fatalf("outsider received events = %#v", outsider.Events)
	}

	ownerService := NewService(ServiceOptions{Repository: repository, BatchSize: 2, ReplayLimit: 10})
	owner, err := ownerService.Replay(ctx, ReplayInput{ActorID: "usr_owner"})
	if err != nil {
		t.Fatal(err)
	}
	if got := eventSeqs(owner.Events); len(got) != 5 || got[0] != 1 || got[1] != 2 || got[2] != 3 || got[3] != 4 || got[4] != 5 {
		t.Fatalf("owner replay = %v", got)
	}
	ownerMessage := owner.Events[1].Payload["message"].(map[string]any)
	ownerAttachment := ownerMessage["attachments"].([]any)[0].(map[string]any)
	if ownerAttachment["capabilities"].(map[string]any)["canRemove"] != true {
		t.Fatalf("owner attachment capabilities = %#v", ownerAttachment["capabilities"])
	}
	if ownerMessage["pin"].(map[string]any)["canUnpin"] != true {
		t.Fatalf("owner pin capabilities = %#v", ownerMessage["pin"])
	}

	if _, err := pool.Exec(ctx, "DELETE FROM workspace_events WHERE seq = 1"); err != nil {
		t.Fatal(err)
	}
	stale, err := ownerService.Replay(ctx, ReplayInput{ActorID: "usr_owner", LastSeq: 0})
	if err != nil {
		t.Fatal(err)
	}
	if !stale.SyncRequired || stale.Reason != SyncReasonReplayWindow || stale.CurrentSeq != 5 {
		t.Fatalf("stale replay = %#v", stale)
	}
	ahead, err := ownerService.Replay(ctx, ReplayInput{ActorID: "usr_owner", LastSeq: 99})
	if err != nil {
		t.Fatal(err)
	}
	if !ahead.SyncRequired || ahead.Reason != SyncReasonCursorAhead || ahead.CurrentSeq != 5 {
		t.Fatalf("ahead replay = %#v", ahead)
	}

	// Syntactically valid JSON with an invalid typed sibling must never select
	// a raw fallback that forwards client-supplied share metadata.
	if _, err := pool.Exec(ctx, `UPDATE messages SET content_json = $1 WHERE id = 'msg-1'`,
		`{"format":"duallane.message+json;v=1","blocks":[{"type":"text","text":123},{"type":"emote_collection","shareId":"forged","share":{"id":"forged","name":"must not leak"}}]}`); err != nil {
		t.Fatal(err)
	}
	if result, err := repository.publicMessagePayload(ctx, DefaultSpaceID, beaconConversation, "msg-1"); err == nil || result != nil {
		t.Fatalf("invalid typed content used raw fallback: result=%#v err=%v", result, err)
	}
}

func seedEventIntegrationData(t *testing.T, ctx context.Context, conn *pgx.Conn, now time.Time) {
	t.Helper()
	for _, user := range []struct {
		id, login, email, name string
	}{
		{"usr_owner", "owner", "owner@example.test", "Owner"},
		{"usr_viewer", "viewer", "viewer@example.test", "Viewer"},
		{"usr_target", "target", "target@example.test", "Target"},
		{"usr_outsider", "outsider", "outsider@example.test", "Outsider"},
	} {
		mustExecEventPG(t, ctx, conn, `
			INSERT INTO users (id, github_login, email, display_name, nickname, kind, created_at, last_login_at)
			VALUES ($1, $2, $3, $4, $4, 'human', $5, $5)
		`, user.id, user.login, user.email, user.name, now)
	}
	mustExecEventPG(t, ctx, conn, `
		INSERT INTO spaces (id, name, slug, created_by, created_at)
		VALUES ($1, 'Events', 'events-integration', 'usr_owner', $2)
	`, DefaultSpaceID, now)
	for _, user := range []struct{ id, role string }{
		{"usr_owner", "owner"}, {"usr_viewer", "member"}, {"usr_target", "member"}, {"usr_outsider", "member"},
	} {
		mustExecEventPG(t, ctx, conn, `
			INSERT INTO space_members (space_id, user_id, role, joined_at)
			VALUES ($1, $2, $3, $4)
		`, DefaultSpaceID, user.id, user.role, now)
	}
	mustExecEventPG(t, ctx, conn, `
		INSERT INTO conversations (id, space_id, type, title, direct_key, created_by, created_at)
		VALUES ('conv-events', $1, 'direct', 'Events', 'events-direct', 'usr_owner', $2)
	`, DefaultSpaceID, now)
	for _, userID := range []string{"usr_owner", "usr_viewer", "usr_target"} {
		mustExecEventPG(t, ctx, conn, `
			INSERT INTO conversation_members (conversation_id, user_id, joined_at)
			VALUES ('conv-events', $1, $2)
		`, userID, now)
	}
	mustExecEventPG(t, ctx, conn, `
		INSERT INTO messages (
			id, space_id, conversation_id, author_id, author_kind, kind,
			client_message_id, content_format, content_json, plain_text, created_at
		) VALUES (
			'msg-1', $1, 'conv-events', 'usr_owner', 'human', 'user',
			'client-msg-1', 'duallane.message+json;v=1',
			'{"format":"duallane.message+json;v=1","plainText":"hello","blocks":[{"type":"text","text":"hello"}]}',
			'hello', $2
		)
	`, DefaultSpaceID, now)
	mustExecEventPG(t, ctx, conn, `
		INSERT INTO message_reactions (message_id, user_id, emote_key, created_at)
		VALUES ('msg-1', 'usr_owner', 'builtin:heart', $1),
			('msg-1', 'usr_viewer', 'builtin:heart', $1 + INTERVAL '1 second')
	`, now)
	mustExecEventPG(t, ctx, conn, `
		INSERT INTO message_hidden_states (user_id, message_id, hidden_at)
		VALUES ('usr_viewer', 'msg-1', $1)
	`, now)
	mustExecEventPG(t, ctx, conn, `
		INSERT INTO conversation_pinned_messages (conversation_id, message_id, pinned_by_user_id, created_at)
		VALUES ('conv-events', 'msg-1', 'usr_owner', $1)
	`, now)
	mustExecEventPG(t, ctx, conn, `
		INSERT INTO attachments (
			id, space_id, uploader_id, conversation_id, visibility, status,
			file_name, mime_type, byte_size, created_at, completed_at
		) VALUES (
			'att-1', $1, 'usr_owner', 'conv-events', 'conversation', 'available',
			'report.txt', 'text/plain', 12, $2, $2
		)
	`, DefaultSpaceID, now)
	mustExecEventPG(t, ctx, conn, `
		INSERT INTO message_attachments (message_id, attachment_id)
		VALUES ('msg-1', 'att-1')
	`)
	mustExecEventPG(t, ctx, conn, `
		INSERT INTO topics (
			id, space_id, conversation_id, title, description, created_by,
			status, allow_sync_to_group, revision, created_at, updated_at
		) VALUES (
			'topic-events', $1, 'conv-events', 'Events topic', '', 'usr_owner',
			'open', false, 1, $2, $2
		)
	`, DefaultSpaceID, now)
	mustExecEventPG(t, ctx, conn, `
		INSERT INTO topic_members (topic_id, user_id, joined_at)
		VALUES ('topic-events', 'usr_owner', $1)
	`, now)
	for _, event := range []struct {
		id, eventType, actorID, conversationID, targetType, targetID, payload string
		seq                                                                   int64
	}{
		{"evt-member", "workspace.member_joined", "usr_owner", "", "user", "usr_target", `{"userId":"usr_target","member":{"id":"usr_target","displayName":"Target","email":"target@example.test"}}`, 1},
		{"evt-message", "message.created", "usr_owner", "conv-events", "", "", `{"messageId":"msg-1","message":{"id":"msg-1","plainText":"hello"}}`, 2},
		{"evt-removed", "workspace.member_removed", "usr_owner", "", "user", "usr_target", `{"userId":"usr_target"}`, 3},
		{"evt-topic-created", "topic.created", "usr_owner", "conv-events", "topic", "topic-events", `{"topicId":"topic-events","conversationId":"conv-events"}`, 4},
		{"evt-topic-message", "topic.message.created", "usr_owner", "conv-events", "topic_message", "topic-message-1", `{"topicId":"topic-events","topicMessageId":"topic-message-1","conversationId":"conv-events"}`, 5},
	} {
		mustExecEventPG(t, ctx, conn, `
			INSERT INTO workspace_events (id, space_id, seq, type, actor_user_id, conversation_id, target_type, target_id, payload_json, created_at)
			VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), $9, $10)
		`, event.id, DefaultSpaceID, event.seq, event.eventType, event.actorID, event.conversationID, event.targetType, event.targetID, event.payload, now.Add(time.Duration(event.seq-1)*time.Second))
	}
	mustExecEventPG(t, ctx, conn, `
		INSERT INTO users (id, github_login, email, display_name, nickname, kind, created_at, last_login_at)
		VALUES ('usr_system_beacon', '__duallane_beacon__', 'beacon@example.test', 'Beacon', 'Beacon', 'bot', $1, $1)
	`, now)
	mustExecEventPG(t, ctx, conn, `
		INSERT INTO space_members (space_id, user_id, role, joined_at)
		VALUES ($1, 'usr_system_beacon', 'member', $2)
	`, DefaultSpaceID, now)
	mustExecEventPG(t, ctx, conn, `
		INSERT INTO conversations (id, space_id, type, title, direct_key, created_by, created_at)
		VALUES ('conv-events-beacon', $1, 'direct', 'Viewer, Beacon', 'usr_system_beacon:usr_viewer', 'usr_viewer', $2)
	`, DefaultSpaceID, now)
	for _, userID := range []string{"usr_viewer", "usr_system_beacon"} {
		mustExecEventPG(t, ctx, conn, `
			INSERT INTO conversation_members (conversation_id, user_id, joined_at)
			VALUES ('conv-events-beacon', $1, $2)
		`, userID, now)
	}
}

func ownerServiceFor(repository Repository) *Service {
	return NewService(ServiceOptions{Repository: repository, BatchSize: 2, ReplayLimit: 10})
}

func mustExecEventPG(t *testing.T, ctx context.Context, conn *pgx.Conn, query string, args ...any) {
	t.Helper()
	if _, err := conn.Exec(ctx, query, args...); err != nil {
		t.Fatal(err)
	}
}

var _ Repository = (*PGRepository)(nil)
