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

	if _, err := conn.Exec(ctx, `
		INSERT INTO users (id, github_login, display_name, kind, created_at)
		VALUES ('bot_search_private', '__duallane_search_private__', 'Private Search Bot', 'bot', $1)
	`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO space_members (space_id, user_id, role, joined_at)
		VALUES ('default', 'bot_search_private', 'member', $1)
	`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO workspace_agent_bots (id, space_id, owner_user_id, bot_user_id, mode, name, name_normalized, visibility_policy, conversation_policy, trigger_policy, status, created_at, updated_at)
		VALUES ('agent_record_search_private', 'default', 'usr_owner', 'bot_search_private', 'external_agent', 'Private Search Bot', 'private search bot', 'private', 'direct-only', 'mention-or-command', 'active', $1, $1)
	`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO workspace_agent_bot_settings (bot_id, space_id, visibility_policy, allow_direct, allow_group, access_policy, created_at, updated_at)
		VALUES ('agent_record_search_private', 'default', 'private', 1, 0, $1::jsonb, $2, $2)
	`, `{"version":2,"discovery":{"audience":"owner_only"},"direct":{"audience":"owner_only"},"groups":{"audience":"owner_only","allowBotTriggers":false}}`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO conversations (id, space_id, type, title, direct_key, created_by, created_at)
		VALUES ('conv_search_private', 'default', 'direct', 'Private Search Bot', 'search-private-direct', 'usr_owner', $1)
	`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO conversation_members (conversation_id, user_id, joined_at)
		VALUES ('conv_search_private', 'usr_owner', $1), ('conv_search_private', 'usr_member', $1), ('conv_search_private', 'bot_search_private', $1)
	`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO messages (id, space_id, conversation_id, author_id, author_kind, kind, content_format, content_json, plain_text, created_at)
		VALUES ('msg_search_private', 'default', 'conv_search_private', 'usr_owner', 'human', 'user', 'duallane.message+json;v=1', '{}', 'private architecture secret', $1)
	`, now); err != nil {
		t.Fatal(err)
	}
	privateSearch, err := repo.Search(ctx, "usr_member", "private architecture", "messages", 20)
	if err != nil {
		t.Fatal(err)
	}
	for _, hit := range privateSearch.Messages {
		if hit.ConversationID == "conv_search_private" {
			t.Fatal("V2 owner-only DM leaked into v1 message search")
		}
	}

	bootstrap, err := repo.GetBootstrap(ctx, "usr_owner", now)
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	var projectedBot *V1BootstrapMember
	for i := range bootstrap.Members {
		member := &bootstrap.Members[i]
		if member.ID == "bot_search_private" {
			projectedBot = member
			break
		}
	}
	if projectedBot == nil || projectedBot.BotID != "agent_record_search_private" {
		t.Fatalf("bootstrap custom bot projection = %#v, want botId agent_record_search_private", projectedBot)
	}
	for _, member := range bootstrap.Members {
		if member.ID == "usr_owner" || member.ID == "usr_member" {
			if member.BotID != "" {
				t.Fatalf("bootstrap human projection leaked botId: %#v", member)
			}
		}
	}
	viewerBootstrap, err := repo.GetBootstrap(ctx, "usr_member", now)
	if err != nil {
		t.Fatalf("member bootstrap: %v", err)
	}
	for _, member := range viewerBootstrap.Members {
		if member.ID == "bot_search_private" {
			t.Fatalf("private custom bot leaked to non-owner bootstrap: %#v", member)
		}
	}
	// Bootstrap is an identity pool for rendered conversations, not a directory
	// grant. Approved group friends must resolve the private Bot's real mention ID.
	for _, statement := range []string{
		`UPDATE workspace_agent_bot_settings SET allow_group=1,access_policy=jsonb_set(access_policy,'{groups,audience}','"current_members"'::jsonb) WHERE bot_id='agent_record_search_private'`,
		`UPDATE workspace_agent_bots SET conversation_policy='group-capable' WHERE id='agent_record_search_private'`,
		`INSERT INTO conversation_members(conversation_id,user_id,joined_at) VALUES('conv_grp_1','bot_search_private',NOW())`,
		`INSERT INTO workspace_agent_bot_group_policies(bot_id,space_id,conversation_id,status,invited_by,approved_by,created_at,updated_at) VALUES('agent_record_search_private','default','conv_grp_1','active','usr_owner','usr_owner',NOW(),NOW())`,
	} {
		if _, err := conn.Exec(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	groupBootstrap, err := repo.GetBootstrap(ctx, "usr_member", now)
	if err != nil {
		t.Fatal(err)
	}
	foundGroupBot := false
	for _, member := range groupBootstrap.Members {
		if member.ID == "bot_search_private" {
			foundGroupBot = member.BotID == "agent_record_search_private"
		}
	}
	if !foundGroupBot {
		t.Fatal("approved group Bot missing from mention identity pool")
	}
	for _, conv := range groupBootstrap.Conversations {
		if conv.ID == "conv_search_private" {
			t.Fatal("group identity incorrectly granted private DM visibility")
		}
	}
	if _, err := conn.Exec(ctx, `UPDATE workspace_agent_bot_group_policies SET status='removed' WHERE bot_id='agent_record_search_private'`); err != nil {
		t.Fatal(err)
	}
	removedBootstrap, err := repo.GetBootstrap(ctx, "usr_member", now)
	if err != nil {
		t.Fatal(err)
	}
	for _, member := range removedBootstrap.Members {
		if member.ID == "bot_search_private" {
			t.Fatal("removed group authorization retained private Bot identity")
		}
	}

	if _, err := conn.Exec(ctx, `UPDATE workspace_agent_bot_group_policies SET status='pending' WHERE bot_id='agent_record_search_private'`); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `UPDATE conversation_members SET role='owner' WHERE conversation_id='conv_grp_1' AND user_id='usr_owner'`); err != nil {
		t.Fatal(err)
	}
	pending, err := repo.ListGroupBotRequests(ctx, "usr_owner", "conv_grp_1")
	if err != nil {
		t.Fatal(err)
	}
	if !pending.CanManage || len(pending.Requests) != 1 || pending.Requests[0].BotID != "agent_record_search_private" {
		t.Fatalf("manager pending projection: %#v", pending)
	}
	ordinary, err := repo.ListGroupBotRequests(ctx, "usr_member", "conv_grp_1")
	if err != nil {
		t.Fatal(err)
	}
	if ordinary.CanManage || len(ordinary.Requests) != 0 {
		t.Fatalf("ordinary member received approval requests: %#v", ordinary)
	}
	if _, err := repo.ListGroupBotRequests(ctx, "not-a-group-member", "conv_grp_1"); err != ErrNotFound {
		t.Fatalf("outsider approval list: %v", err)
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
