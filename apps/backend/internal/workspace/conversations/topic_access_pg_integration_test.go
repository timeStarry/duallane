//go:build postgres_integration

package conversations

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
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	platformmigrations "github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/emotes"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/files"
)

func TestPGTopicAttachmentsEmotesAndPinsRespectCurrentMembership(t *testing.T) {
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
	schema := fmt.Sprintf("duallane_topic_access_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		_, _ = conn.Exec(cleanup, "DROP SCHEMA IF EXISTS "+identifier+" CASCADE")
	})
	if _, err := conn.Exec(ctx, "SET search_path TO "+identifier); err != nil {
		t.Fatal(err)
	}
	_, source, _, _ := runtime.Caller(0)
	if _, err := (platformmigrations.Runner{Beginner: platformpostgres.NewMigrationBeginner(conn), Directory: filepath.Clean(filepath.Join(filepath.Dir(source), "../../../../web/server/migrations"))}).Run(ctx); err != nil {
		t.Fatal(err)
	}
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Date(2026, 9, 11, 8, 0, 0, 0, time.UTC)
	for _, id := range []string{"owner", "member", "outsider", "admin"} {
		exec(`INSERT INTO users (id, github_login, display_name, kind, created_at) VALUES ($1, $1, $1, 'human', $2)`, id, now)
	}
	exec(`INSERT INTO spaces (id, name, slug, created_by, created_at) VALUES ('spc_default', 'Topic fixture', 'topic-access', 'owner', $1)`, now)
	for _, id := range []string{"owner", "member", "outsider", "admin"} {
		role := "member"
		if id == "owner" || id == "admin" {
			role = id
		}
		exec(`INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES ('spc_default', $1, $2, $3)`, id, role, now)
	}
	exec(`INSERT INTO conversations (id, space_id, type, title, created_by, created_at, retention_count) VALUES ('g', 'spc_default', 'group', 'Group', 'owner', $1, 1000)`, now)
	for _, id := range []string{"owner", "member", "outsider", "admin"} {
		exec(`INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES ('g', $1, $2)`, id, now)
	}
	exec(`INSERT INTO topics (id, space_id, conversation_id, title, description, created_by, created_at, updated_at) VALUES ('topic', 'spc_default', 'g', 'Private topic body', '', 'owner', $1, $1)`, now)
	for _, id := range []string{"owner", "member"} {
		exec(`INSERT INTO topic_members (topic_id, user_id, joined_at) VALUES ('topic', $1, $2)`, id, now)
	}
	exec(`INSERT INTO messages (id, space_id, conversation_id, topic_id, author_id, author_kind, kind, content_format, content_json, plain_text, created_at)
		VALUES ('topic-message', 'spc_default', 'g', 'topic', 'owner', 'human', 'user', 'duallane.message+json;v=1', '{"format":"duallane.message+json;v=1","blocks":[{"type":"text","text":"private body"}],"plainText":"private body"}', 'private body', $1)`, now)
	for _, id := range []string{"topic-file", "unsent-file"} {
		exec(`INSERT INTO attachments (id, space_id, uploader_id, visibility, status, file_name, mime_type, byte_size, storage_key, created_at, completed_at)
			VALUES ($1, 'spc_default', 'owner', 'private_staging', 'available', 'private.txt', 'text/plain', 10, 'synthetic-object', $2, $2)`, id, now)
	}
	exec(`INSERT INTO message_attachments (message_id, attachment_id) VALUES ('topic-message', 'topic-file')`)
	exec(`INSERT INTO workspace_custom_emotes (id, user_id, source_type, label, sort_order, created_at) VALUES ('topic-emote', 'owner', 'upload', 'private emote', 0, $1)`, now)
	exec(`INSERT INTO message_custom_emotes (message_id, custom_emote_id) VALUES ('topic-message', 'topic-emote')`)
	var sequence atomic.Int64
	ids := func() (string, error) { return fmt.Sprintf("topic-access-%d", sequence.Add(1)), nil }
	fileService := files.NewService(files.ServiceOptions{Repository: files.NewPGRepository(pool, ids), IDFactory: ids})
	emoteRepo := emotes.NewPGRepository(pool, ids)
	service := NewService(ServiceOptions{Repository: NewPGRepository(pool, ids), IDFactory: ids})
	// Authorization remains true until the mutation transaction commits: topic
	// closure and membership removal cannot pass a row lock held by pin access.
	if err := NewPGRepository(pool).WithTx(ctx, func(tx Tx) error {
		status, err := tx.(TopicPinReader).TopicPinStatus(ctx, DefaultSpaceID, "g", "topic", "member")
		if err != nil || status != "open" {
			return fmt.Errorf("locked status=%s error=%v", status, err)
		}
		for _, update := range []string{
			`UPDATE topics SET status = 'closed' WHERE id = 'topic'`,
			`UPDATE topic_members SET left_at = NOW() WHERE topic_id = 'topic' AND user_id = 'member'`,
			`UPDATE conversation_members SET removed_at = NOW() WHERE conversation_id = 'g' AND user_id = 'member'`,
		} {
			writer, err := pool.Begin(ctx)
			if err != nil {
				return err
			}
			if _, err := writer.Exec(ctx, `SET LOCAL lock_timeout = '30ms'`); err != nil {
				_ = writer.Rollback(ctx)
				return err
			}
			_, err = writer.Exec(ctx, update)
			_ = writer.Rollback(ctx)
			var pgError *pgconn.PgError
			if !errors.As(err, &pgError) || pgError.Code != "55P03" {
				return fmt.Errorf("revocation passed active pin authorization lock: %v", err)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	fileReadable := func(actor string, want bool) {
		t.Helper()
		_, err := fileService.GetDownloadableAttachment(ctx, actor, "topic-file", auth.RequestMeta{})
		if (err == nil) != want {
			t.Fatalf("file access actor=%s error=%v want=%v", actor, err, want)
		}
	}
	emoteReadable := func(actor string, want bool) {
		t.Helper()
		visible, err := emoteRepo.EmoteVisibleTo(ctx, DefaultSpaceID, actor, "topic-emote")
		if err != nil || visible != want {
			t.Fatalf("emote access actor=%s visible=%v error=%v want=%v", actor, visible, err, want)
		}
	}
	pinsVisible := func(actor string, want int) {
		t.Helper()
		pins, err := service.ListPins(ctx, ConversationInput{ActorID: actor, ConversationID: "g"})
		if err != nil || len(pins) != want {
			t.Fatalf("pin list actor=%s count=%d error=%v want=%d", actor, len(pins), err, want)
		}
	}
	for _, actor := range []string{"owner", "member"} {
		fileReadable(actor, true)
		emoteReadable(actor, true)
	}
	for _, actor := range []string{"outsider", "admin"} {
		fileReadable(actor, false)
		emoteReadable(actor, false)
	}
	for _, actor := range []string{"member", "outsider", "admin"} {
		listed, err := fileService.ListFiles(ctx, files.ListFilesInput{ActorID: actor})
		if err != nil || len(listed) != 0 {
			t.Fatalf("topic files leaked into general file list for %s: %#v %v", actor, listed, err)
		}
	}
	input := PinInput{ActorID: "owner", ConversationID: "g", MessageID: "topic-message"}
	pinned, err := service.Pin(ctx, input)
	if err != nil || pinned.Message.TopicID != "topic" {
		t.Fatalf("pin topic message: %#v %v", pinned, err)
	}
	if _, err := service.Pin(ctx, input); err != nil {
		t.Fatalf("duplicate pin: %v", err)
	}
	pinsVisible("member", 1)
	pinsVisible("outsider", 0)
	pinsVisible("admin", 0)
	if _, err := service.Unpin(ctx, PinInput{ActorID: "admin", ConversationID: "g", MessageID: "topic-message"}); err == nil {
		t.Fatal("unjoined admin unpinned topic message")
	}
	var typeName, topicID string
	if err := pool.QueryRow(ctx, `SELECT type, payload_json::jsonb->>'topicId' FROM workspace_events WHERE type = 'topic.message.pinned'`).Scan(&typeName, &topicID); err != nil || topicID != "topic" {
		t.Fatalf("topic audience event: %s %s %v", typeName, topicID, err)
	}

	// Revocation is checked on every read, including the original uploader.
	for _, id := range []string{"owner", "member"} {
		exec(`UPDATE topic_members SET left_at = $1 WHERE topic_id = 'topic' AND user_id = $2`, now, id)
		fileReadable(id, false)
		emoteReadable(id, false)
		pinsVisible(id, 0)
		listed, err := fileService.ListFiles(ctx, files.ListFilesInput{ActorID: id})
		if err != nil {
			t.Fatal(err)
		}
		for _, file := range listed {
			if file.ID == "topic-file" {
				t.Fatal("left topic attachment remained in uploader list")
			}
		}
		exec(`UPDATE topic_members SET left_at = NULL WHERE topic_id = 'topic' AND user_id = $1`, id)
		exec(`UPDATE conversation_members SET removed_at = $1 WHERE conversation_id = 'g' AND user_id = $2`, now, id)
		fileReadable(id, false)
		emoteReadable(id, false)
		exec(`UPDATE conversation_members SET removed_at = NULL WHERE conversation_id = 'g' AND user_id = $1`, id)
	}
	exec(`UPDATE space_members SET removed_at = $1 WHERE user_id = 'member'`, now)
	fileReadable("member", false)
	emoteReadable("member", false)
	exec(`UPDATE space_members SET removed_at = NULL, role = 'auditor' WHERE user_id = 'member'`)
	fileReadable("member", false)
	emoteReadable("member", false)
	if _, err := service.ListPins(ctx, ConversationInput{ActorID: "member", ConversationID: "g"}); !isCode(err, CodePermissionDenied) {
		t.Fatalf("auditor pin list must reject: %v", err)
	}
	exec(`UPDATE space_members SET role = 'member' WHERE user_id = 'member'`)
	exec(`UPDATE topics SET status = 'closed' WHERE id = 'topic'`)
	fileReadable("member", true)
	if _, err := service.Pin(ctx, input); !isCode(err, "topic.not_open") {
		t.Fatalf("closed pin must reject: %v", err)
	}
	if _, err := service.Unpin(ctx, input); !isCode(err, "topic.not_open") {
		t.Fatalf("closed unpin must reject: %v", err)
	}
	closedPins, err := service.ListPins(ctx, ConversationInput{ActorID: "owner", ConversationID: "g"})
	if err != nil || len(closedPins) != 1 || closedPins[0].CanUnpin || closedPins[0].Message.Pin.CanUnpin {
		t.Fatalf("closed pin projection: %#v %v", closedPins, err)
	}
	exec(`UPDATE topics SET status = 'open' WHERE id = 'topic'`)
	if removed, err := service.Unpin(ctx, input); err != nil || !removed.Removed {
		t.Fatalf("unpin topic: %#v %v", removed, err)
	}
	exec(`UPDATE messages SET recalled_at = $1 WHERE id = 'topic-message'`, now)
	fileReadable("member", false)
	fileReadable("owner", false)
	emoteReadable("member", false)
	if _, err := fileService.GetDownloadableAttachment(ctx, "owner", "unsent-file", auth.RequestMeta{}); err != nil {
		t.Fatalf("unrelated own staging lost access: %v", err)
	}
	exec(`UPDATE messages SET recalled_at = NULL, deleted_at = $1 WHERE id = 'topic-message'`, now)
	fileReadable("member", false)
	emoteReadable("member", false)
}
