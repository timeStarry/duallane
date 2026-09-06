//go:build postgres_integration

package conversations

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
	platformmigrations "github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

func TestPGConversationProjectionsHydrateMessageRelationsAndOmitRecalledPin(t *testing.T) {
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

	schema := fmt.Sprintf("duallane_conversation_projection_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		if _, err := conn.Exec(cleanupCtx, "DROP SCHEMA IF EXISTS "+identifier+" CASCADE"); err != nil {
			t.Errorf("drop conversation projection schema %s: %v", schema, err)
		}
		cleanupCancel()
		if err := conn.Close(context.Background()); err != nil {
			t.Errorf("close conversation projection connection: %v", err)
		}
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

	now := time.Date(2026, 9, 7, 15, 0, 0, 0, time.UTC)
	if _, err := conn.Exec(ctx, `
		INSERT INTO users (id, github_login, display_name, kind, created_at)
		VALUES
			('usr_projection_owner', 'projection-owner', 'Projection Owner', 'human', $1),
			('usr_projection_viewer', 'projection-viewer', 'Projection Viewer', 'human', $1)
	`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO spaces (id, name, slug, created_by, created_at)
		VALUES ('spc_default', 'DualLane', 'conversation-projection', 'usr_projection_owner', $1)
	`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
		VALUES
			('spc_default', 'usr_projection_owner', 'owner', $1, NULL),
			('spc_default', 'usr_projection_viewer', 'member', $1, NULL)
	`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO user_remarks (owner_user_id, target_user_id, remark, updated_at)
		VALUES ('usr_projection_viewer', 'usr_projection_owner', 'Owner alias', $1)
	`, now); err != nil {
		t.Fatal(err)
	}
	conversationID := "projection-group"
	messageID := "projection-message"
	attachmentID := "projection-attachment"
	if _, err := conn.Exec(ctx, `
		INSERT INTO conversations (id, space_id, type, title, direct_key, retention_count, created_by, created_at)
		VALUES ($1, 'spc_default', 'group', 'Projection group', NULL, 10000, 'usr_projection_owner', $2)
	`, conversationID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at)
		VALUES ($1, 'usr_projection_owner', $2, NULL), ($1, 'usr_projection_viewer', $2, NULL)
	`, conversationID, now); err != nil {
		t.Fatal(err)
	}
	contentJSON := `{"format":"duallane.message+json;v=1","plainText":"pinned projection","blocks":[{"type":"attachment","attachmentId":"projection-attachment"}]}`
	if _, err := conn.Exec(ctx, `
		INSERT INTO messages (
			id, space_id, conversation_id, author_id, author_kind, kind,
			content_format, content_json, plain_text, created_at
		) VALUES ($1, 'spc_default', $2, 'usr_projection_owner', 'human', 'user', 'duallane.message+json;v=1', $3, 'pinned projection', $4)
	`, messageID, conversationID, contentJSON, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO attachments (
			id, space_id, uploader_id, conversation_id, visibility, status,
			file_name, mime_type, byte_size, storage_key, created_at, completed_at
		) VALUES ($1, 'spc_default', 'usr_projection_owner', $2, 'conversation', 'available', 'projection.png', 'image/png', 32, NULL, $3, $3)
	`, attachmentID, conversationID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO message_attachments (message_id, attachment_id)
		VALUES ($1, $2)
	`, messageID, attachmentID); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO message_reactions (message_id, user_id, emote_key, created_at)
		VALUES ($1, 'usr_projection_viewer', 'builtin:heart', $2)
	`, messageID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO message_hidden_states (user_id, message_id, hidden_at)
		VALUES
			('usr_projection_viewer', $1, $2),
			('usr_projection_owner', $1, $2)
	`, messageID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO conversation_pinned_messages (conversation_id, message_id, pinned_by_user_id, created_at)
		VALUES ($1, $2, 'usr_projection_owner', $3)
	`, conversationID, messageID, now); err != nil {
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

	service := NewService(ServiceOptions{
		Repository: NewPGRepository(pool),
		SpaceID:    DefaultSpaceID,
		Now:        func() time.Time { return now },
	})
	viewerConversation, err := service.GetConversation(ctx, ConversationInput{ActorID: "usr_projection_viewer", ConversationID: conversationID})
	if err != nil {
		t.Fatal(err)
	}
	viewerMessage := findConversationMessageForReadTest(viewerConversation, messageID)
	if viewerMessage == nil {
		t.Fatalf("viewer latest message is missing: %#v", viewerConversation.LatestMessages)
	}
	if len(viewerMessage.Attachments) != 1 || viewerMessage.Attachments[0].ID != attachmentID || viewerMessage.Attachments[0].UploaderName != "Owner alias" {
		t.Fatalf("viewer attachment projection = %#v, want viewer-specific uploader", viewerMessage.Attachments)
	}
	if len(viewerMessage.Reactions) != 1 || viewerMessage.Reactions[0].EmoteKey != "builtin:heart" || !viewerMessage.Reactions[0].ReactedByCurrentUser {
		t.Fatalf("viewer reaction projection = %#v", viewerMessage.Reactions)
	}
	if !viewerMessage.HiddenByCurrentUser {
		t.Fatal("viewer hidden state = false, want true")
	}
	if viewerConversation.LastMessagePlainText != "" || viewerConversation.LastMessageAt != nil {
		t.Fatalf("hidden latest message became conversation last message: text=%q at=%v", viewerConversation.LastMessagePlainText, viewerConversation.LastMessageAt)
	}

	viewerPins, err := service.ListPins(ctx, ConversationInput{ActorID: "usr_projection_viewer", ConversationID: conversationID})
	if err != nil {
		t.Fatal(err)
	}
	if len(viewerPins) != 1 {
		t.Fatalf("viewer pins = %d, want one", len(viewerPins))
	}
	if pinMessage := viewerPins[0].Message; pinMessage.Pin == nil || len(pinMessage.Attachments) != 1 || len(pinMessage.Reactions) != 1 || !pinMessage.HiddenByCurrentUser {
		t.Fatalf("viewer pin projection = %#v, want all message relations", viewerPins[0].Message)
	}

	ownerPin, err := service.Pin(ctx, PinInput{ActorID: "usr_projection_owner", ConversationID: conversationID, MessageID: messageID, Meta: auth.RequestMeta{RequestID: "projection-existing-pin"}})
	if err != nil {
		t.Fatal(err)
	}
	if ownerPin.Message.Pin == nil || len(ownerPin.Message.Attachments) != 1 || ownerPin.Message.Attachments[0].UploaderName != "projection-owner" || len(ownerPin.Message.Reactions) != 1 || !ownerPin.Message.HiddenByCurrentUser {
		t.Fatalf("existing pin response = %#v, want owner-viewer relations", ownerPin.Message)
	}
	if ownerPin.Message.Reactions[0].ReactedByCurrentUser {
		t.Fatal("owner incorrectly reported as reacting to viewer reaction")
	}

	recalledAt := now.Add(time.Minute)
	if _, err := pool.Exec(ctx, `UPDATE messages SET recalled_at = $2, recall_reason = 'projection test' WHERE id = $1`, messageID, recalledAt); err != nil {
		t.Fatal(err)
	}
	recalledPins, err := service.ListPins(ctx, ConversationInput{ActorID: "usr_projection_viewer", ConversationID: conversationID})
	if err != nil {
		t.Fatal(err)
	}
	if len(recalledPins) != 1 {
		t.Fatalf("recalled pins = %d, want stale pin row projected", len(recalledPins))
	}
	if recalledPins[0].Message.Pin != nil {
		t.Fatalf("recalled message pin = %#v, want omitted", recalledPins[0].Message.Pin)
	}
}
