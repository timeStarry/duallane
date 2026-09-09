//go:build postgres_integration

package conversations

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
	platformmigrations "github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

func TestPGConversationReadMarkerMatchesNodeSemantics(t *testing.T) {
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

	schema := fmt.Sprintf("duallane_conversation_read_%d", time.Now().UnixNano())
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

	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	if _, err := conn.Exec(ctx, `
		INSERT INTO users (id, github_login, display_name, kind, created_at)
		VALUES
			('usr_read_owner', 'read-owner', 'Read Owner', 'human', $1),
			('usr_read_member', 'read-member', 'Read Member', 'human', $1)
	`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO spaces (id, name, slug, created_by, created_at)
		VALUES ('spc_default', 'DualLane', 'conversation-read-marker', 'usr_read_owner', $1)
	`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
		VALUES
			('spc_default', 'usr_read_owner', 'owner', $1, NULL),
			('spc_default', 'usr_read_member', 'member', $1, NULL)
	`, now); err != nil {
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
	if err := pool.Ping(ctx); err != nil {
		t.Fatal(err)
	}

	var idSequence atomic.Int64
	idFactory := func() (string, error) {
		return fmt.Sprintf("conversation-read-%d", idSequence.Add(1)), nil
	}
	service := NewService(ServiceOptions{
		Repository: NewPGRepository(pool, idFactory),
		SpaceID:    DefaultSpaceID,
		Now:        func() time.Time { return now },
		IDFactory:  idFactory,
	})
	group, err := service.CreateConversation(ctx, CreateConversationInput{
		ActorID:   "usr_read_owner",
		Type:      string(ConversationTypeGroup),
		Title:     "Read marker group",
		MemberIDs: []string{"usr_read_member"},
		Meta:      auth.RequestMeta{RequestID: "conversation-read-create"},
	})
	if err != nil {
		t.Fatalf("create group: %v", err)
	}

	initial, err := service.ListConversations(ctx, "usr_read_member", auth.RequestMeta{RequestID: "conversation-read-initial"})
	if err != nil {
		t.Fatalf("list initial conversations: %v", err)
	}
	initialConversation := requireConversationForReadTest(t, initial, group.ID)
	if initialConversation.UnreadCount != 1 {
		t.Fatalf("initial unread count = %d, want one system message", initialConversation.UnreadCount)
	}
	if initialConversation.LastReadSeq != nil || initialConversation.LastReadMessageID != nil {
		t.Fatalf("initial read marker = seq:%v message:%v, want nil", initialConversation.LastReadSeq, initialConversation.LastReadMessageID)
	}

	read, err := service.MarkRead(ctx, ConversationInput{
		ActorID:        "usr_read_member",
		ConversationID: group.ID,
		Meta:           auth.RequestMeta{RequestID: "conversation-read-mark"},
	})
	if err != nil {
		t.Fatalf("mark read: %v", err)
	}
	if read.UnreadCount != 0 || read.LastReadSeq == nil || read.LastReadMessageID == nil {
		t.Fatalf("read result = unread:%d seq:%v message:%v, want zero with marker", read.UnreadCount, read.LastReadSeq, read.LastReadMessageID)
	}
	var storedReadSeq int64
	var storedReadMessageID *string
	if err := pool.QueryRow(ctx, `
		SELECT last_read_seq, last_read_message_id
		FROM conversation_members
		WHERE conversation_id = $1 AND user_id = 'usr_read_member'
	`, group.ID).Scan(&storedReadSeq, &storedReadMessageID); err != nil {
		t.Fatal(err)
	}
	if storedReadSeq != *read.LastReadSeq || storedReadMessageID == nil || *storedReadMessageID != *read.LastReadMessageID {
		t.Fatalf("stored marker = seq:%d message:%v, result = seq:%d message:%s", storedReadSeq, storedReadMessageID, *read.LastReadSeq, *read.LastReadMessageID)
	}

	if err := insertReadMarkerMessage(ctx, pool, group.ID, "usr_read_member", "read-member-message", "member message", now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := insertReadMarkerMessage(ctx, pool, group.ID, "usr_read_owner", "read-owner-message", "owner message", now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO attachments (
			id, space_id, uploader_id, conversation_id, visibility, status,
			file_name, mime_type, byte_size, storage_key, created_at
		) VALUES ($1, $2, $3, $4, 'conversation', 'available', $5, 'image/png', 68, NULL, $6)
	`, "read-owner-attachment", DefaultSpaceID, "usr_read_owner", group.ID, "synthetic.png", now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO message_attachments (message_id, attachment_id)
		VALUES ('read-owner-message', 'read-owner-attachment')
	`); err != nil {
		t.Fatal(err)
	}

	withNewMessages, err := service.GetConversation(ctx, ConversationInput{
		ActorID:        "usr_read_member",
		ConversationID: group.ID,
		Meta:           auth.RequestMeta{RequestID: "conversation-read-after-messages"},
	})
	if err != nil {
		t.Fatalf("get after messages: %v", err)
	}
	if withNewMessages.UnreadCount != 1 {
		t.Fatalf("unread after own and owner messages = %d, want one owner message", withNewMessages.UnreadCount)
	}
	if message := findConversationMessageForReadTest(withNewMessages, "read-owner-message"); message == nil || len(message.Attachments) != 1 || message.Attachments[0].ID != "read-owner-attachment" || message.Attachments[0].MIMEType != "image/png" {
		t.Fatalf("get conversation attachment projection = %#v, want one image attachment", message)
	}
	if withNewMessages.LastReadSeq == nil || *withNewMessages.LastReadSeq != storedReadSeq {
		t.Fatalf("marker changed before second read = %v, want %d", withNewMessages.LastReadSeq, storedReadSeq)
	}
	// This is the browser symptom when the realtime snapshot says zero and the
	// client therefore never sends POST /conversations/:id/read: the persisted
	// marker is still NULL, so the system message and the owner's message are
	// both unread while the member's own message is excluded.
	if _, err := pool.Exec(ctx, `
		UPDATE conversation_members
		SET last_read_message_id = NULL, last_read_at = NULL, last_read_seq = NULL
		WHERE conversation_id = $1 AND user_id = 'usr_read_member'
	`, group.ID); err != nil {
		t.Fatal(err)
	}
	withoutMarker, err := service.ListConversations(ctx, "usr_read_member", auth.RequestMeta{RequestID: "conversation-read-missing-marker"})
	if err != nil {
		t.Fatalf("list without marker: %v", err)
	}
	if got := requireConversationForReadTest(t, withoutMarker, group.ID).UnreadCount; got != 2 {
		t.Fatalf("unread without persisted marker = %d, want system plus owner message", got)
	}

	readAgain, err := service.MarkRead(ctx, ConversationInput{
		ActorID:        "usr_read_member",
		ConversationID: group.ID,
		Meta:           auth.RequestMeta{RequestID: "conversation-read-mark-again"},
	})
	if err != nil {
		t.Fatalf("mark read after messages: %v", err)
	}
	if readAgain.UnreadCount != 0 {
		t.Fatalf("unread after second mark = %d, want zero", readAgain.UnreadCount)
	}
	if message := findConversationMessageForReadTest(readAgain, "read-owner-message"); message == nil || len(message.Attachments) != 1 || message.Attachments[0].ID != "read-owner-attachment" || message.Attachments[0].Status != "available" {
		t.Fatalf("mark read attachment projection = %#v, want available attachment", message)
	}

	listedAgain, err := service.ListConversations(ctx, "usr_read_member", auth.RequestMeta{RequestID: "conversation-read-list-again"})
	if err != nil {
		t.Fatalf("list after second mark: %v", err)
	}
	if got := requireConversationForReadTest(t, listedAgain, group.ID).UnreadCount; got != 0 {
		t.Fatalf("listed unread after second mark = %d, want zero", got)
	}
}

func insertReadMarkerMessage(ctx context.Context, pool *pgxpool.Pool, conversationID, authorID, messageID, plainText string, createdAt time.Time) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(context.Background())
		}
	}()

	contentJSON := fmt.Sprintf(`{"format":"duallane.message+json;v=1","plainText":%q,"blocks":[{"type":"text","text":%q}]}`, plainText, plainText)
	if _, err := tx.Exec(ctx, `
		INSERT INTO messages (
			id, space_id, conversation_id, author_id, author_kind, kind,
			content_format, content_json, plain_text, created_at
		) VALUES ($1, $2, $3, $4, 'human', 'user', 'duallane.message+json;v=1', $5, $6, $7)
	`, messageID, DefaultSpaceID, conversationID, authorID, contentJSON, plainText, createdAt.UTC()); err != nil {
		return err
	}
	var sequence int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO workspace_event_cursors (space_id, next_seq)
		VALUES ($1, COALESCE((SELECT MAX(seq) + 1 FROM workspace_events WHERE space_id = $1), 1))
		ON CONFLICT (space_id) DO UPDATE SET next_seq = workspace_event_cursors.next_seq + 1
		RETURNING next_seq - 1
	`, DefaultSpaceID).Scan(&sequence); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO workspace_events (
			id, space_id, seq, type, actor_user_id, conversation_id,
			target_type, target_id, payload_json, created_at
		) VALUES ($1, $2, $3, 'message.created', $4, $5, 'message', $6, $7, $8)
	`, "event-"+messageID, DefaultSpaceID, sequence, authorID, conversationID, messageID,
		fmt.Sprintf(`{"messageId":%q,"conversationId":%q}`, messageID, conversationID), createdAt.UTC()); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	committed = true
	return nil
}

func requireConversationForReadTest(t *testing.T, conversations []Conversation, id string) Conversation {
	t.Helper()
	for _, conversation := range conversations {
		if conversation.ID == id {
			return conversation
		}
	}
	t.Fatalf("conversation %s not found in %#v", id, conversations)
	return Conversation{}
}

func findConversationMessageForReadTest(conversation Conversation, messageID string) *Message {
	for index := range conversation.LatestMessages {
		if conversation.LatestMessages[index].ID == messageID {
			return &conversation.LatestMessages[index]
		}
	}
	return nil
}
