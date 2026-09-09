//go:build postgres_integration

package botgateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
)

func TestPGBotGatewayAuthenticationContextAndReplay(t *testing.T) {
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

	schema := fmt.Sprintf("duallane_botgateway_%d", time.Now().UnixNano())
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
	rawToken := "dl_bot_" + strings.Repeat("a", 40)
	seedBotGatewayPG(t, ctx, conn, now, rawToken)
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
	service := NewService(ServiceOptions{
		Repository:  repository,
		SpaceID:     DefaultSpaceID,
		Now:         func() time.Time { return now },
		ReplayLimit: 20,
	})
	authValue, err := service.Authenticate(ctx, "Bearer "+rawToken, TokenAuthOptions{SpaceID: DefaultSpaceID})
	if err != nil {
		t.Fatal(err)
	}
	if authValue.TokenID != "token-botgateway" || authValue.BotID != "bot-botgateway" || authValue.UserID != "user-botgateway" {
		t.Fatalf("authenticated bot = %#v", authValue)
	}
	if len(authValue.Scopes) != 2 || authValue.Scopes[0] != ScopeMessagesReadTrigger || authValue.Scopes[1] != ScopeMessagesReadContext {
		t.Fatalf("authenticated scopes = %#v", authValue.Scopes)
	}
	var storedHash string
	if err := pool.QueryRow(ctx, `SELECT token_hash FROM workspace_agent_bot_tokens WHERE id = $1`, authValue.TokenID).Scan(&storedHash); err != nil {
		t.Fatal(err)
	}
	if storedHash != HashToken(rawToken) || storedHash == rawToken {
		t.Fatalf("bot token persistence is not hash-only: %q", storedHash)
	}
	me, err := service.GetMe(ctx, authValue)
	if err != nil {
		t.Fatal(err)
	}
	if me.Version != Version || me.SpaceID != DefaultSpaceID || me.Connection == nil || me.Connection.Status != "connected" || me.Connection.UpdatedAt != "2026-09-04T12:34:56.789Z" {
		t.Fatalf("gateway me projection = %#v", me)
	}
	firstCleanup, err := service.RegisterConnection(ctx, authValue, ConnectionRegistration{AdapterVersion: "integration-v1", Nonce: "nonce-integration-v1"})
	if err != nil {
		t.Fatal(err)
	}
	secondCleanup, err := service.RegisterConnection(ctx, authValue, ConnectionRegistration{AdapterVersion: "integration-v2", Nonce: "nonce-integration-v2"})
	if err != nil {
		t.Fatal(err)
	}
	heartbeat, err := service.Heartbeat(ctx, authValue, "nonce-integration-v2")
	if err != nil || heartbeat.Timestamp != "2026-09-04T12:34:56.789Z" {
		t.Fatalf("connection heartbeat = %#v err=%v", heartbeat, err)
	}
	if err := secondCleanup(ctx); err != nil {
		t.Fatal(err)
	}
	if err := firstCleanup(ctx); err != nil {
		t.Fatal(err)
	}
	var connectionStatus, connectionNonce, adapterVersion string
	if err := pool.QueryRow(ctx, `SELECT status, connection_nonce, adapter_version FROM workspace_agent_bot_connections WHERE bot_id = $1`, authValue.BotID).Scan(&connectionStatus, &connectionNonce, &adapterVersion); err != nil {
		t.Fatal(err)
	}
	if connectionStatus != "disconnected" || connectionNonce != "nonce-integration-v2" || adapterVersion != "integration-v2" {
		t.Fatalf("connection lifecycle = status=%q nonce=%q adapter=%q", connectionStatus, connectionNonce, adapterVersion)
	}

	contextResult, err := service.GetContext(ctx, authValue, "conversation-botgateway", map[string]any{"limit": 10})
	if err != nil {
		t.Fatal(err)
	}
	projection, ok := contextResult["conversation"].(ConversationProjection)
	if !ok || projection.ID != "conversation-botgateway" || projection.CreatedAt != "2026-09-04T12:34:56.789Z" {
		t.Fatalf("conversation projection = %#v", contextResult["conversation"])
	}
	contextMessages, ok := contextResult["messages"].([]ContextMessage)
	if !ok || len(contextMessages) != 1 || contextMessages[0].ID != "message-botgateway" || contextMessages[0].CreatedAt != "2026-09-04T12:34:56.789Z" {
		t.Fatalf("context messages = %#v", contextResult["messages"])
	}
	blocks, ok := contextMessages[0].Content["blocks"].([]any)
	if !ok || len(blocks) != 1 {
		t.Fatalf("projected blocks = %#v", contextMessages[0].Content["blocks"])
	}
	if block, ok := blocks[0].(map[string]any); !ok || block["type"] != "attachment" || block["attachmentId"] != "attachment-botgateway" {
		t.Fatalf("projected attachment block = %#v", blocks[0])
	} else if _, leaked := block["secret"]; leaked {
		t.Fatal("attachment private field leaked into bot context")
	}

	events, err := repository.ListEventsAfter(ctx, DefaultSpaceID, 0, 10)
	if err != nil || len(events) != 1 || events[0].Sequence != 1 {
		t.Fatalf("persistent event list = %#v err=%v", events, err)
	}
	replay, err := service.Replay(ctx, authValue, ReplayInput{LastSequence: 0, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if replay.CurrentSequence != 1 || len(replay.Events) != 1 || replay.Events[0].Sequence != 1 || replay.Events[0].Status != "delivered" {
		t.Fatalf("first replay = %#v", replay)
	}
	if len(replay.Events[0].Payload) != 0 {
		t.Fatalf("message delivery persisted content = %#v", replay.Events[0].Payload)
	}
	var deliveryStatus string
	if err := pool.QueryRow(ctx, `SELECT status FROM workspace_agent_bot_deliveries WHERE bot_id = $1 AND sequence = 1`, authValue.BotID).Scan(&deliveryStatus); err != nil {
		t.Fatal(err)
	}
	if deliveryStatus != "delivered" {
		t.Fatalf("delivery status = %q", deliveryStatus)
	}

	if _, err := pool.Exec(ctx, `UPDATE conversation_members SET removed_at = $1 WHERE conversation_id = $2 AND user_id = $3`, now, "conversation-botgateway", authValue.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.GetContext(ctx, authValue, "conversation-botgateway", nil); !isCode(err, CodeConversationNotFound) {
		t.Fatalf("removed bot context error = %v", err)
	}
	stale, err := service.Replay(ctx, authValue, ReplayInput{LastSequence: 0, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(stale.Events) != 0 || !stale.SyncRequired || stale.Reason != "replay_window_exceeded" {
		t.Fatalf("replay after membership removal = %#v", stale)
	}
	var expiredStatus string
	if err := pool.QueryRow(ctx, `SELECT status FROM workspace_agent_bot_deliveries WHERE bot_id = $1 AND sequence = 1`, authValue.BotID).Scan(&expiredStatus); err != nil {
		t.Fatal(err)
	}
	if expiredStatus != "expired" {
		t.Fatalf("removed member delivery status = %q", expiredStatus)
	}

	if _, err := pool.Exec(ctx, `UPDATE workspace_agent_bot_tokens SET revoked_at = $1 WHERE id = $2`, now, authValue.TokenID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ValidateAuth(ctx, authValue); !isCode(err, CodeInvalidToken) {
		t.Fatalf("revoked bot token error = %v", err)
	}
}

func seedBotGatewayPG(t *testing.T, ctx context.Context, conn *pgx.Conn, now time.Time, rawToken string) {
	t.Helper()
	mustExecBotGatewayPG(t, ctx, conn, `
		INSERT INTO users (id, github_id, github_login, email, display_name, nickname, kind, created_at, last_login_at)
		VALUES
			('user-owner-botgateway', 'github-owner-botgateway', 'owner-botgateway', 'owner@example.test', 'Owner', 'Owner', 'human', $1, $1),
			('user-botgateway', NULL, 'bot-botgateway', NULL, 'Gateway Bot', 'Gateway Bot', 'bot', $1, NULL)
	`, now)
	mustExecBotGatewayPG(t, ctx, conn, `
		INSERT INTO spaces (id, name, slug, created_by, created_at)
		VALUES ($1, 'Bot Gateway', 'botgateway-integration', 'user-owner-botgateway', $2)
	`, DefaultSpaceID, now)
	mustExecBotGatewayPG(t, ctx, conn, `
		INSERT INTO space_members (space_id, user_id, role, joined_at)
		VALUES
			($1, 'user-owner-botgateway', 'owner', $2),
			($1, 'user-botgateway', 'member', $2)
	`, DefaultSpaceID, now)
	mustExecBotGatewayPG(t, ctx, conn, `
		INSERT INTO conversations (id, space_id, type, title, direct_key, created_by, created_at)
		VALUES ('conversation-botgateway', $1, 'direct', 'Gateway conversation', 'botgateway-direct', 'user-owner-botgateway', $2)
	`, DefaultSpaceID, now)
	mustExecBotGatewayPG(t, ctx, conn, `
		INSERT INTO conversation_members (conversation_id, user_id, joined_at)
		VALUES
			('conversation-botgateway', 'user-owner-botgateway', $1),
			('conversation-botgateway', 'user-botgateway', $1)
	`, now)
	mustExecBotGatewayPG(t, ctx, conn, `
		INSERT INTO messages (
			id, space_id, conversation_id, author_id, author_kind, kind, client_message_id,
			content_format, content_json, plain_text, created_at
		) VALUES (
			'message-botgateway', $1, 'conversation-botgateway', 'user-owner-botgateway', 'human', 'user', 'client-botgateway',
			'duallane.message+json;v=1',
			'{"format":"duallane.message+json;v=1","plainText":"context","blocks":[{"type":"attachment","attachmentId":"attachment-botgateway","secret":"must-not-leak"}]}',
			'context', $2
		)
	`, DefaultSpaceID, now)
	mustExecBotGatewayPG(t, ctx, conn, `
		INSERT INTO workspace_agent_bots (
			id, space_id, owner_user_id, bot_user_id, name, name_normalized,
			visibility_policy, conversation_policy, trigger_policy, status, created_at, updated_at
		) VALUES (
			'bot-botgateway', $1, 'user-owner-botgateway', 'user-botgateway', 'Gateway Bot', 'gateway bot',
			'private', 'direct-only', 'mention-or-command', 'active', $2, $2
		)
	`, DefaultSpaceID, now)
	scopes, err := json.Marshal([]string{ScopeMessagesReadContext, ScopeMessagesReadTrigger})
	if err != nil {
		t.Fatal(err)
	}
	mustExecBotGatewayPG(t, ctx, conn, `
		INSERT INTO workspace_agent_bot_tokens (id, bot_id, space_id, token_hash, scopes_json, created_at)
		VALUES ('token-botgateway', 'bot-botgateway', $1, $2, $3, $4)
	`, DefaultSpaceID, HashToken(rawToken), string(scopes), now)
	mustExecBotGatewayPG(t, ctx, conn, `
		INSERT INTO workspace_agent_bot_settings (bot_id, space_id, created_at, updated_at)
		VALUES ('bot-botgateway', $1, $2, $2)
	`, DefaultSpaceID, now)
	mustExecBotGatewayPG(t, ctx, conn, `
		INSERT INTO workspace_agent_bot_context_grants (
			grant_id, bot_id, space_id, conversation_id, allow_trigger, allow_context,
			max_messages, granted_by, created_at, updated_at
		) VALUES ('grant-botgateway', 'bot-botgateway', $1, 'conversation-botgateway', 1, 1, 10, 'user-owner-botgateway', $2, $2)
	`, DefaultSpaceID, now)
	mustExecBotGatewayPG(t, ctx, conn, `
		INSERT INTO workspace_agent_bot_limits (bot_id, space_id, created_at, updated_at)
		VALUES ('bot-botgateway', $1, $2, $2)
	`, DefaultSpaceID, now)
	mustExecBotGatewayPG(t, ctx, conn, `
		INSERT INTO workspace_agent_bot_connections (
			id, bot_id, space_id, status, adapter_version, connected_at, updated_at
		) VALUES ('connection-botgateway', 'bot-botgateway', $1, 'connected', 'v1', $2, $2)
	`, DefaultSpaceID, now)
	mustExecBotGatewayPG(t, ctx, conn, `
		INSERT INTO workspace_events (
			id, space_id, seq, type, actor_user_id, conversation_id, target_type, target_id, payload_json, created_at
		) VALUES (
			'event-botgateway', $1, 1, 'message.created', 'user-owner-botgateway', 'conversation-botgateway',
			'message', 'message-botgateway', '{"messageId":"message-botgateway"}', $2
		)
	`, DefaultSpaceID, now)
	mustExecBotGatewayPG(t, ctx, conn, `
		INSERT INTO workspace_event_cursors (space_id, next_seq)
		VALUES ($1, 2)
	`, DefaultSpaceID)
}

func mustExecBotGatewayPG(t *testing.T, ctx context.Context, conn *pgx.Conn, query string, args ...any) {
	t.Helper()
	if _, err := conn.Exec(ctx, query, args...); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) {
			t.Fatalf("postgres error %s: %s", pgErr.Code, pgErr.Message)
		}
		t.Fatal(err)
	}
}
