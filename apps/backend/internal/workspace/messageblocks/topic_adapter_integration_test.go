//go:build postgres_integration

package messageblocks

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	"github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/topics"
)

func TestPGInlineTopicCreationIsAtomicAndIdempotent(t *testing.T) {
	ctx, pool := inlineTopicDatabase(t)
	topicRepository := topics.NewPGRepository(pool)
	topicService := topics.NewService(topics.ServiceOptions{Repository: topicRepository})
	messageRepository := messages.NewPGRepository(pool)
	messageRepository.SetTopicRepository(topicRepository)
	service := messages.NewService(messages.ServiceOptions{Repository: messageRepository, GroupTopicCreator: NewGroupTopicCreator(topicService, "")})
	input := messages.CreateInput{ActorID: "inline-owner", ConversationID: "inline-group", ClientMessageID: "inline-request", Content: inlineText("#[并发话题](正文 (包含括号))")}

	const parallel = 8
	results := make([]messages.Message, parallel)
	errorsFound := make([]error, parallel)
	var workers sync.WaitGroup
	for index := range results {
		workers.Add(1)
		go func() {
			defer workers.Done()
			results[index], errorsFound[index] = service.CreateMessage(ctx, input)
		}()
	}
	workers.Wait()
	for index, result := range results {
		if errorsFound[index] != nil || result.ID == "" || result.ID != results[0].ID || result.ClientMessageID == nil || *result.ClientMessageID != input.ClientMessageID {
			t.Fatalf("replay %d: result=%+v err=%v", index, result, errorsFound[index])
		}
		if len(result.Content.Blocks) != 2 || result.Content.Blocks[1].Type != "card" || result.Content.Blocks[1].CardType != topics.TopicCardType {
			t.Fatalf("not a topic card: %+v", result.Content)
		}
	}
	var topicID, storedKey string
	if err := pool.QueryRow(ctx, `SELECT id FROM topics WHERE idempotency_key=$1`, input.ClientMessageID).Scan(&topicID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT client_message_id FROM messages WHERE id=$1`, results[0].ID).Scan(&storedKey); err != nil || storedKey != "topic-card:"+topicID {
		t.Fatalf("persisted key=%q err=%v", storedKey, err)
	}
	for table, expected := range map[string]int{"topics": 1, "topic_members": 1, "messages": 2, "workspace_cards": 1, "workspace_events": 4, "audit_logs": 3} {
		assertInlineCount(t, ctx, pool, "SELECT count(*) FROM "+table, expected)
	}
	assertInlineCount(t, ctx, pool, `SELECT count(*) FROM workspace_events WHERE payload_json LIKE '%inline-request%'`, 0)

	changed := input
	changed.Content = inlineText("#[不同话题](正文)")
	if _, err := service.CreateMessage(ctx, changed); !inlineErrorCode(err, topics.CodeTopicIdempotencyConflict) {
		t.Fatalf("changed topic key: %v", err)
	}
	changed.Content = inlineText("ordinary text")
	if _, err := service.CreateMessage(ctx, changed); !inlineErrorCode(err, messages.CodeMessageIdempotency) {
		t.Fatalf("non-topic reuse: %v", err)
	}
	assertInlineCount(t, ctx, pool, `SELECT count(*) FROM audit_logs WHERE result='rejected'`, 2)
	assertInlineCount(t, ctx, pool, `SELECT count(*) FROM topics`, 1)
	assertInlineCount(t, ctx, pool, `SELECT count(*) FROM messages`, 2)

	// Force a late failure after both messages and events were written. No part
	// of the topic bundle, including success audits, may escape the transaction.
	if _, err := pool.Exec(ctx, `ALTER TABLE workspace_cards ADD CONSTRAINT inline_reject_card CHECK (source_id IS NULL OR source_id = '`+topicID+`')`); err != nil {
		t.Fatal(err)
	}
	failure := input
	failure.ClientMessageID = "inline-failure"
	if _, err := service.CreateMessage(ctx, failure); err == nil {
		t.Fatal("late card failure unexpectedly committed")
	}
	for table, expected := range map[string]int{"topics": 1, "topic_members": 1, "messages": 2, "workspace_cards": 1, "workspace_events": 4, "audit_logs": 5} {
		assertInlineCount(t, ctx, pool, "SELECT count(*) FROM "+table, expected)
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE workspace_cards DROP CONSTRAINT inline_reject_card`); err != nil {
		t.Fatal(err)
	}

	ordinary := []messages.Content{
		inlineText("prefix #[not a topic](body)"),
		inlineText("#[broken](body"),
		{Format: messages.MessageContentFormat, Blocks: []messages.Block{{Type: "text", Text: "#[link](body)"}, {Type: "link", URL: "https://example.com", Label: "link"}}},
	}
	for index, content := range ordinary {
		input.ClientMessageID = fmt.Sprintf("ordinary-%d", index)
		input.Content = content
		if _, err := service.CreateMessage(ctx, input); err != nil {
			t.Fatalf("ordinary case %d: %v", index, err)
		}
	}
	input.ClientMessageID = "reply"
	input.Content = inlineText("#[reply](body)")
	input.ReplyToMessageID = results[0].ID
	if _, err := service.CreateMessage(ctx, input); err != nil {
		t.Fatal(err)
	}
	assertInlineCount(t, ctx, pool, `SELECT count(*) FROM topics`, 1)

	// Competing ordinary and topic requests with one key cannot create both.
	input.ReplyToMessageID = ""
	input.ClientMessageID = "competing-shapes"
	inputs := []messages.CreateInput{input, input}
	inputs[1].Content = inlineText("ordinary competitor")
	var outcomes [2]error
	for index := range inputs {
		workers.Add(1)
		go func() {
			defer workers.Done()
			_, outcomes[index] = service.CreateMessage(ctx, inputs[index])
		}()
	}
	workers.Wait()
	if (outcomes[0] == nil) == (outcomes[1] == nil) {
		t.Fatalf("exactly one shape must win: %v", outcomes)
	}
	for _, err := range outcomes {
		if err != nil && !inlineErrorCode(err, messages.CodeMessageIdempotency) {
			t.Fatalf("unexpected competing error: %v", err)
		}
	}
}

func inlineText(value string) messages.Content {
	return messages.Content{Format: messages.MessageContentFormat, Blocks: []messages.Block{{Type: "text", Text: value}}}
}

func inlineErrorCode(err error, code string) bool {
	var domainErr *messages.Error
	return errors.As(err, &domainErr) && domainErr.Code == code
}

func assertInlineCount(t *testing.T, ctx context.Context, pool *pgxpool.Pool, query string, expected int) {
	t.Helper()
	var count int
	if err := pool.QueryRow(ctx, query).Scan(&count); err != nil || count != expected {
		t.Fatalf("%s: count=%d expected=%d err=%v", query, count, expected, err)
	}
}

func inlineTopicDatabase(t *testing.T) (context.Context, *pgxpool.Pool) {
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
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	schema := fmt.Sprintf("duallane_inline_topic_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		if _, err := conn.Exec(cleanupCtx, "DROP SCHEMA "+identifier+" CASCADE"); err != nil {
			t.Error(err)
		}
	})
	if _, err := conn.Exec(ctx, "SET search_path TO "+identifier); err != nil {
		t.Fatal(err)
	}
	_, source, _, _ := runtime.Caller(0)
	directory := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../../web/server/migrations"))
	if _, err := (migrations.Runner{Beginner: postgres.NewMigrationBeginner(conn), Directory: directory}).Run(ctx); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		`INSERT INTO users (id,github_login,display_name,kind,created_at,last_login_at) VALUES ('inline-owner','inline-owner','Owner','human',NOW(),NOW())`,
		`INSERT INTO spaces (id,name,slug,created_by,created_at) VALUES ('spc_default','Inline','inline','inline-owner',NOW())`,
		`INSERT INTO space_members (space_id,user_id,role,joined_at) VALUES ('spc_default','inline-owner','owner',NOW())`,
		`INSERT INTO conversations (id,space_id,type,title,retention_count,created_by,created_at) VALUES ('inline-group','spc_default','group','Inline group',10000,'inline-owner',NOW())`,
		`INSERT INTO conversation_members (conversation_id,user_id,joined_at) VALUES ('inline-group','inline-owner',NOW())`,
	} {
		if _, err := conn.Exec(ctx, query); err != nil {
			t.Fatal(err)
		}
	}
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = strings.TrimSpace(schema)
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return ctx, pool
}
