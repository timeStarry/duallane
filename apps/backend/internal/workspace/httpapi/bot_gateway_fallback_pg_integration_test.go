//go:build postgres_integration

package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/botgateway"
	workspacecards "github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/feishucards"
	workspacemessages "github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

func TestBotGatewayHTTPToPGExplicitFallbackHashReplay(t *testing.T) {
	ctx, pool, rawToken := openBotGatewayHTTPFallbackDatabase(t)
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	messageRepository := workspacemessages.NewPGRepository(pool)
	cardRepository := workspacecards.NewPGRepository(pool)
	registry, err := workspacecards.NewRegistry(feishucards.AsCardsDefinition())
	if err != nil {
		t.Fatal(err)
	}
	messageService := workspacemessages.NewService(workspacemessages.ServiceOptions{
		Repository: messageRepository, SpaceID: botgateway.DefaultSpaceID, Now: func() time.Time { return now }, AllowBots: true,
	})
	cardService := workspacecards.NewService(workspacecards.ServiceOptions{
		Repository: cardRepository, Registry: registry, SpaceID: botgateway.DefaultSpaceID, Now: func() time.Time { return now },
	})
	adapters := botgateway.NewRuntimeAdapters(botgateway.RuntimeAdapterOptions{Messages: messageService, Cards: cardService})
	gatewayRepository := botgateway.NewPGRepositoryWithDomainTransactions(pool, botgateway.DomainTransactionOptions{Messages: messageRepository, Cards: cardRepository})
	service := botgateway.NewService(botgateway.ServiceOptions{
		Repository: gatewayRepository, MessageWriter: adapters.MessageWriter, CardGateway: adapters.CardGateway,
		SpaceID: botgateway.DefaultSpaceID, Now: func() time.Time { return now },
	})
	router := chi.NewRouter()
	registerBotGatewayRoutes(router, BotGatewayRouteOptions{Gateway: service, WorkspaceEnabled: true})

	rawCard := `{"header":{"title":{"tag":"plain_text","content":"\ud800 title"}},"elements":[{"tag":"div","text":{"tag":"plain_text","content":"body"}}]}`
	converted, err := feishucards.ConvertJSON([]byte(rawCard))
	if err != nil {
		t.Fatal(err)
	}
	body := `{"conversationId":"conversation-botgateway","clientMessageId":"http-feishu-fallback-message","idempotencyKey":"http-feishu-fallback-key","format":"feishu-card","feishuCard":{"header":{"title":{"tag":"plain_text","content":"\ud800 title"}},"elements":[{"tag":"div","text":{"tag":"plain_text","content":"body"}}]},"fallbackText":"\ud800 explicit"}`
	var first botgateway.SendCardResult
	for attempt := 0; attempt < 2; attempt++ {
		request := httptest.NewRequest(http.MethodPost, "/api/bot-gateway/v1/cards", strings.NewReader(body))
		request.Header.Set("Authorization", "Bearer "+rawToken)
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != http.StatusCreated {
			t.Fatalf("attempt %d status = %d, body = %s", attempt, response.Code, response.Body.String())
		}
		var result botgateway.SendCardResult
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if attempt == 0 {
			first = result
		} else if result.Card.ID != first.Card.ID || result.Message.ID != first.Message.ID {
			t.Fatalf("replay result = %#v, want original card/message", result)
		}
	}
	if first.Card.FallbackText != "\ufffd explicit" {
		t.Fatalf("HTTP response fallback = %q, want replacement-normalized value", first.Card.FallbackText)
	}

	var storedFallback, storedHash string
	if err := pool.QueryRow(ctx, `SELECT fallback_text FROM workspace_cards WHERE id = $1`, first.Card.ID).Scan(&storedFallback); err != nil {
		t.Fatal(err)
	}
	if storedFallback != "\ufffd explicit" {
		t.Fatalf("PG fallback = %q, want replacement-normalized value", storedFallback)
	}
	if err := pool.QueryRow(ctx, `SELECT request_hash FROM workspace_agent_bot_idempotency WHERE bot_id = 'bot-botgateway' AND operation = 'card.send' AND idempotency_key = 'http-feishu-fallback-key'`).Scan(&storedHash); err != nil {
		t.Fatal(err)
	}
	hashInput := []byte(`{"conversationId":"conversation-botgateway","cardType":"feishu.adaptive.v1","schemaVersion":1,"fallbackText":"\ud800 explicit","payload":`)
	hashInput = append(hashInput, converted.PayloadJSON...)
	hashInput = append(hashInput, '}')
	digest := sha256.Sum256(hashInput)
	if storedHash != hex.EncodeToString(digest[:]) {
		t.Fatalf("HTTP PG request hash = %s, want Node-compatible hash", storedHash)
	}

	var cards, messages, events, audits int
	if err := pool.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM workspace_cards), (SELECT COUNT(*) FROM messages), (SELECT COUNT(*) FROM workspace_events), (SELECT COUNT(*) FROM audit_logs)`).Scan(&cards, &messages, &events, &audits); err != nil {
		t.Fatal(err)
	}
	if cards != 1 || messages != 1 || events != 2 || audits != 2 {
		t.Fatalf("post-replay counts = cards:%d messages:%d events:%d audits:%d", cards, messages, events, audits)
	}
}

func openBotGatewayHTTPFallbackDatabase(t *testing.T) (context.Context, *pgxpool.Pool, string) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	t.Cleanup(cancel)
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	schema := fmt.Sprintf("duallane_http_fallback_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := conn.Exec(cleanupCtx, "DROP SCHEMA "+identifier+" CASCADE"); err != nil {
			t.Error(err)
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
	if _, err := (migrations.Runner{
		Beginner: platformpostgres.NewMigrationBeginner(conn), Directory: migrationDirectory,
	}).Run(ctx); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	rawToken := "dl_bot_" + strings.Repeat("h", 40)
	queries := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users (id, github_id, github_login, email, display_name, nickname, kind, created_at, last_login_at)
			VALUES ('user-owner-botgateway', 'github-owner-botgateway', 'owner-botgateway', 'owner@example.test', 'Owner', 'Owner', 'human', $1, $1),
			('user-botgateway', NULL, 'bot-botgateway', NULL, 'Gateway Bot', 'Gateway Bot', 'bot', $1, NULL)`, []any{now}},
		{`INSERT INTO spaces (id, name, slug, created_by, created_at) VALUES ($1, 'Bot Gateway', 'http-fallback-integration', 'user-owner-botgateway', $2)`, []any{botgateway.DefaultSpaceID, now}},
		{`INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES ($1, 'user-owner-botgateway', 'owner', $2), ($1, 'user-botgateway', 'member', $2)`, []any{botgateway.DefaultSpaceID, now}},
		{`INSERT INTO conversations (id, space_id, type, title, direct_key, created_by, created_at) VALUES ('conversation-botgateway', $1, 'direct', 'Gateway conversation', 'http-fallback-direct', 'user-owner-botgateway', $2)`, []any{botgateway.DefaultSpaceID, now}},
		{`INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES ('conversation-botgateway', 'user-owner-botgateway', $1), ('conversation-botgateway', 'user-botgateway', $1)`, []any{now}},
		{`INSERT INTO workspace_agent_bots (id, space_id, owner_user_id, bot_user_id, name, name_normalized, visibility_policy, conversation_policy, trigger_policy, status, created_at, updated_at)
			VALUES ('bot-botgateway', $1, 'user-owner-botgateway', 'user-botgateway', 'Gateway Bot', 'gateway bot', 'private', 'direct-only', 'mention-or-command', 'active', $2, $2)`, []any{botgateway.DefaultSpaceID, now}},
		{`INSERT INTO workspace_agent_bot_tokens (id, bot_id, space_id, token_hash, scopes_json, created_at) VALUES ('token-botgateway', 'bot-botgateway', $1, $2, $3, $4)`, []any{botgateway.DefaultSpaceID, botgateway.HashToken(rawToken), `["cards:write","messages:send"]`, now}},
		{`INSERT INTO workspace_agent_bot_settings (bot_id, space_id, created_at, updated_at) VALUES ('bot-botgateway', $1, $2, $2)`, []any{botgateway.DefaultSpaceID, now}},
		{`INSERT INTO workspace_agent_bot_limits (bot_id, space_id, created_at, updated_at) VALUES ('bot-botgateway', $1, $2, $2)`, []any{botgateway.DefaultSpaceID, now}},
		{`INSERT INTO workspace_event_cursors (space_id, next_seq) VALUES ($1, 1)`, []any{botgateway.DefaultSpaceID}},
	}
	for _, item := range queries {
		if _, err := conn.Exec(ctx, item.query, item.args...); err != nil {
			t.Fatal(err)
		}
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
	t.Cleanup(pool.Close)
	return ctx, pool, rawToken
}
