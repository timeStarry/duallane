//go:build postgres_integration

package v1

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
)

func TestPGSearchResolvesAttachmentSourceMessageFromJoinTable(t *testing.T) {
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

	schema := fmt.Sprintf("duallane_v1_search_%d", time.Now().UnixNano())
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
	migrationDirectory := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../web/server/migrations"))
	if _, err := (platformmigrations.Runner{
		Beginner:  platformpostgres.NewMigrationBeginner(conn),
		Directory: migrationDirectory,
	}).Run(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(migrationDirectory, "036_v1_clean_architecture.sql")); os.IsNotExist(err) {
		deferredSQL, readErr := os.ReadFile(filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../platform/migrations/testdata/036_v1_clean_architecture.sql")))
		if readErr != nil {
			t.Fatal(readErr)
		}
		if _, execErr := conn.Exec(ctx, string(deferredSQL)); execErr != nil {
			t.Fatal(execErr)
		}
	}

	now := time.Date(2026, 11, 14, 5, 0, 0, 0, time.UTC)
	if _, err := conn.Exec(ctx, `
		INSERT INTO spaces (id, slug, name, created_at)
		VALUES ('default', 'default', 'Default', $1)
	`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO users (id, github_login, display_name, kind, created_at)
		VALUES
			('usr_owner', 'owner', 'Owner', 'human', $1),
			('usr_member', 'member', 'Member', 'human', $1)
	`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO space_members (space_id, user_id, role, joined_at)
		VALUES
			('default', 'usr_owner', 'owner', $1),
			('default', 'usr_member', 'member', $1)
	`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO conversations (id, space_id, type, title, created_by, created_at)
		VALUES ('conv_grp_1', 'default', 'group', 'Architecture Group', 'usr_owner', $1)
	`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO conversation_members (conversation_id, user_id, joined_at)
		VALUES
			('conv_grp_1', 'usr_owner', $1),
			('conv_grp_1', 'usr_member', $1)
	`, now); err != nil {
		t.Fatal(err)
	}

	if _, err := conn.Exec(ctx, `
		INSERT INTO messages (
			id, space_id, conversation_id, author_id, author_kind, kind,
			client_message_id, content_format, content_json, plain_text, created_at
		) VALUES (
			'msg_with_file_1', 'default', 'conv_grp_1', 'usr_owner', 'human', 'user',
			'cli_file_1', 'duallane.message+json;v=1',
			'{"format":"duallane.message+json;v=1","plainText":"architecture spec","blocks":[{"type":"text","text":"architecture spec"}]}',
			'architecture spec', $1
		)
	`, now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO attachments (
			id, space_id, uploader_id, conversation_id, source_message_id, visibility, status,
			file_name, mime_type, byte_size, storage_key, created_at
		) VALUES
			('att_linked_1', 'default', 'usr_owner', 'conv_grp_1', NULL, 'conversation', 'available', 'architecture-diagram.png', 'image/png', 1024, NULL, $1),
			('att_unlinked_1', 'default', 'usr_owner', 'conv_grp_1', NULL, 'conversation', 'available', 'architecture-draft.pdf', 'application/pdf', 2048, NULL, $2)
	`, now.Add(time.Second), now.Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO message_attachments (message_id, attachment_id)
		VALUES ('msg_with_file_1', 'att_linked_1')
	`); err != nil {
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

	repo := NewPGRepository(pool, "default")
	res, err := repo.Search(ctx, "usr_member", "architecture", "files", 20)
	if err != nil {
		t.Fatalf("search files: %v", err)
	}
	if len(res.Files) != 2 {
		t.Fatalf("expected 2 file hits, got %d: %#v", len(res.Files), res.Files)
	}

	byID := map[string]SearchFileHit{}
	for _, hit := range res.Files {
		byID[hit.ID] = hit
	}
	linked := byID["att_linked_1"]
	if linked.ConversationID != "conv_grp_1" || linked.SourceMessageID != "msg_with_file_1" {
		t.Fatalf("linked attachment backlink = (%q, %q), want (conv_grp_1, msg_with_file_1)", linked.ConversationID, linked.SourceMessageID)
	}
	unlinked := byID["att_unlinked_1"]
	if unlinked.SourceMessageID != "" {
		t.Fatalf("unlinked attachment sourceMessageId = %q, want empty", unlinked.SourceMessageID)
	}
	// Reading connection diagnostics must not recreate a revoked trigger grant.
	botID, err := repo.CreateMultiBot(ctx, "usr_owner", "Read-only console fixture", now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `UPDATE workspace_agent_bot_context_grants SET allow_trigger=0,allow_context=0 WHERE bot_id=$1`, botID); err != nil {
		t.Fatal(err)
	}
	if _, err := NewPGRepository(pool, "default").GetBotConsoleOverview(ctx, "usr_owner", botID, now); err != nil {
		t.Fatal(err)
	}
	var allowTrigger, allowContext int
	if err := conn.QueryRow(ctx, `SELECT allow_trigger,allow_context FROM workspace_agent_bot_context_grants WHERE bot_id=$1`, botID).Scan(&allowTrigger, &allowContext); err != nil {
		t.Fatal(err)
	}
	if allowTrigger != 0 || allowContext != 0 {
		t.Fatalf("console read restored revoked access: trigger=%d context=%d", allowTrigger, allowContext)
	}

}
