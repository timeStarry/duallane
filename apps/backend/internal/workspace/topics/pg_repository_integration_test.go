//go:build postgres_integration

package topics

import (
	"context"
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
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

func TestPGTopicVerticalSliceIsTransactionalAndProjected(t *testing.T) {
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

	schema := fmt.Sprintf("duallane_topics_%d", time.Now().UnixNano())
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
	seedTopicPG(t, ctx, conn, now)
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

	var nextID atomic.Int64
	repository := NewPGRepository(pool)
	service := NewService(ServiceOptions{
		Repository: repository,
		Now:        func() time.Time { return now },
		IDFactory: func() (string, error) {
			return fmt.Sprintf("generated-%03d", nextID.Add(1)), nil
		},
	})
	meta := auth.RequestMeta{RequestID: "topic-pg-request", IPAddress: "198.51.100.7", UserAgent: "integration"}
	topic, err := service.Create(ctx, CreateInput{
		ActorID:          "usr_topic_owner",
		ConversationID:   "conv-topic-pg",
		Title:            "PG 话题",
		Description:      "只允许成员读取的正文",
		AllowSyncToGroup: true,
		IdempotencyKey:   ".create-1",
		Meta:             meta,
	})
	if err != nil {
		t.Fatal(err)
	}
	if topic.CreatedAt != "2026-09-04T12:34:56.789Z" || !topic.Joined || topic.ParticipantCount != 1 {
		t.Fatalf("created topic = %#v", topic)
	}
	topics, err := service.List(ctx, ListInput{ActorID: "usr_topic_owner", ConversationID: "conv-topic-pg"})
	if err != nil || len(topics) != 1 || topics[0].ID != topic.ID {
		t.Fatalf("default topic list = %#v err=%v", topics, err)
	}
	if _, err := service.Create(ctx, CreateInput{
		ActorID:          "usr_topic_owner",
		ConversationID:   "conv-topic-pg",
		Title:            "PG 话题",
		Description:      "只允许成员读取的正文",
		AllowSyncToGroup: true,
		IdempotencyKey:   ".create-1",
	}); err != nil {
		t.Fatalf("idempotent create: %v", err)
	}

	joined, err := service.Join(ctx, TopicInput{ActorID: "usr_topic_member", TopicID: topic.ID, Meta: meta})
	if err != nil {
		var domainError *Error
		if errors.As(err, &domainError) {
			t.Fatalf("join topic: %s: %v", domainError.Code, domainError.Cause)
		}
		t.Fatal(err)
	}
	if !joined.Joined || joined.ParticipantCount != 2 {
		t.Fatalf("joined topic = %#v", joined)
	}
	members, err := service.ListMembers(ctx, TopicInput{ActorID: "usr_topic_member", TopicID: topic.ID})
	if err != nil || len(members) != 2 {
		t.Fatalf("members=%#v err=%v", members, err)
	}

	message, err := service.CreateMessage(ctx, CreateMessageInput{
		ActorID:         "usr_topic_owner",
		TopicID:         topic.ID,
		ClientMessageID: "topic-pg-message-1",
		Body:            "成员消息",
		Meta:            meta,
	})
	if err != nil {
		t.Fatal(err)
	}
	if message.Message.PlainText != "成员消息" || message.EventSeq < 1 {
		t.Fatalf("message result = %#v", message)
	}
	listed, err := service.ListMessages(ctx, MessageListInput{ActorID: "usr_topic_member", TopicID: topic.ID, Limit: 20})
	if err != nil || len(listed) != 2 {
		t.Fatalf("listed=%#v err=%v", listed, err)
	}
	read, err := service.MarkRead(ctx, ReadInput{ActorID: "usr_topic_member", TopicID: topic.ID, MessageID: message.Message.ID, Meta: meta})
	if err != nil {
		t.Fatal(err)
	}
	if read.LastReadMessageID == nil || *read.LastReadMessageID != message.Message.ID || read.UnreadCount != 0 {
		t.Fatalf("read result = %#v", read)
	}

	initial, err := service.ListMessages(ctx, MessageListInput{ActorID: "usr_topic_owner", TopicID: topic.ID, Limit: 1})
	if err != nil || len(initial) != 1 {
		t.Fatalf("initial page=%#v err=%v", initial, err)
	}
	synced, err := service.SyncMessage(ctx, SyncInput{ActorID: "usr_topic_owner", TopicID: topic.ID, MessageID: initial[0].ID, Meta: meta})
	if err != nil {
		t.Fatal(err)
	}
	if synced.Projection == nil || synced.Projection.GroupConversationID != "conv-topic-pg" {
		t.Fatalf("sync result = %#v", synced)
	}
	unsynced, err := service.UnsyncMessage(ctx, SyncInput{ActorID: "usr_topic_owner", TopicID: topic.ID, MessageID: initial[0].ID, Meta: meta})
	if err != nil {
		t.Fatal(err)
	}
	if !unsynced.Removed || unsynced.Projection == nil || unsynced.Projection.RemovedAt == nil {
		t.Fatalf("unsync result = %#v", unsynced)
	}

	var auditCount int
	if err := conn.QueryRow(ctx, `SELECT COUNT(*) FROM audit_logs WHERE request_id = $1 AND (action = 'topic.create' OR action = 'topic.message.create')`, meta.RequestID).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if auditCount < 2 {
		t.Fatalf("audit rows = %d", auditCount)
	}
	var privateColumns int
	if err := conn.QueryRow(ctx, `SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'workspace_cards' AND column_name IN ('email', 'github_id')`).Scan(&privateColumns); err != nil {
		t.Fatal(err)
	}
	if privateColumns != 0 {
		t.Fatalf("unexpected private card columns = %d", privateColumns)
	}
}

func seedTopicPG(t *testing.T, ctx context.Context, conn *pgx.Conn, now time.Time) {
	t.Helper()
	for _, user := range []struct {
		id, login, name string
	}{
		{"usr_topic_owner", "topic-owner", "Owner"},
		{"usr_topic_member", "topic-member", "Member"},
	} {
		mustExecTopicPG(t, ctx, conn, `
			INSERT INTO users (id, github_id, github_login, email, display_name, nickname, avatar_url, kind, created_at, last_login_at)
			VALUES ($1, NULL, $2, NULL, $3, $3, NULL, 'human', $4, $4)
		`, user.id, user.login, user.name, now)
	}
	mustExecTopicPG(t, ctx, conn, `
		INSERT INTO spaces (id, name, slug, created_by, created_at)
		VALUES ('spc_default', 'Topics', 'topics-integration', 'usr_topic_owner', $1)
	`, now)
	for _, user := range []struct{ id, role string }{
		{"usr_topic_owner", "owner"},
		{"usr_topic_member", "member"},
	} {
		mustExecTopicPG(t, ctx, conn, `
			INSERT INTO space_members (space_id, user_id, role, joined_at)
			VALUES ('spc_default', $1, $2, $3)
		`, user.id, user.role, now)
	}
	mustExecTopicPG(t, ctx, conn, `
		INSERT INTO conversations (id, space_id, type, title, direct_key, retention_count, created_by, created_at)
		VALUES ('conv-topic-pg', 'spc_default', 'group', 'Topic group', NULL, 10000, 'usr_topic_owner', $1)
	`, now)
	for _, userID := range []string{"usr_topic_owner", "usr_topic_member"} {
		mustExecTopicPG(t, ctx, conn, `
			INSERT INTO conversation_members (conversation_id, user_id, joined_at)
			VALUES ('conv-topic-pg', $1, $2)
		`, userID, now)
	}
}

func mustExecTopicPG(t *testing.T, ctx context.Context, conn *pgx.Conn, query string, args ...any) {
	t.Helper()
	if _, err := conn.Exec(ctx, query, args...); err != nil {
		t.Fatal(err)
	}
}
