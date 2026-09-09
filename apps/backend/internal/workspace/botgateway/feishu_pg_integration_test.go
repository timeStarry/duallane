//go:build postgres_integration

package botgateway

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workspacecards "github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/feishucards"
	workspacemessages "github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

func TestPGGatewayFeishuCreateHashAndOwnerRejectionUseRealServices(t *testing.T) {
	ctx, pool := openBotGatewayAtomicityDatabase(t)
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	rawToken := "dl_bot_" + strings.Repeat("f", 40)
	if _, err := pool.Exec(ctx, `UPDATE workspace_agent_bot_tokens SET token_hash = $1, scopes_json = $2 WHERE id = 'token-botgateway'`, HashToken(rawToken), `[
		"cards:write",
		"messages:send"
	]`); err != nil {
		t.Fatal(err)
	}

	messageRepository := workspacemessages.NewPGRepository(pool)
	cardRepository := workspacecards.NewPGRepository(pool)
	registry, err := workspacecards.NewRegistry(feishucards.AsCardsDefinition())
	if err != nil {
		t.Fatal(err)
	}
	messageService := workspacemessages.NewService(workspacemessages.ServiceOptions{
		Repository: messageRepository, SpaceID: DefaultSpaceID, Now: func() time.Time { return now }, AllowBots: true,
	})
	cardService := workspacecards.NewService(workspacecards.ServiceOptions{
		Repository: cardRepository, Registry: registry, SpaceID: DefaultSpaceID, Now: func() time.Time { return now },
	})
	adapters := NewRuntimeAdapters(RuntimeAdapterOptions{Messages: messageService, Cards: cardService})
	gatewayRepository := NewPGRepositoryWithDomainTransactions(pool, DomainTransactionOptions{Messages: messageRepository, Cards: cardRepository})
	service := NewService(ServiceOptions{
		Repository: gatewayRepository, MessageWriter: adapters.MessageWriter, CardGateway: adapters.CardGateway,
		SpaceID: DefaultSpaceID, Now: func() time.Time { return now },
	})
	authValue, err := service.Authenticate(ctx, "Bearer "+rawToken, TokenAuthOptions{SpaceID: DefaultSpaceID})
	if err != nil {
		t.Fatal(err)
	}

	raw := json.RawMessage(`{"elements":[{"tag":"div","text":{"tag":"plain_text","content":"审批"}}]}`)
	converted, err := feishucards.ConvertJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	input := SendCardInput{
		ConversationID: "conversation-botgateway", ClientMessageID: "pg-feishu-message", IdempotencyKey: "pg-feishu-key",
		Format: "feishu-card", RawFeishuCard: raw,
		Fields: map[string]any{"format": "feishu-card", "feishuCard": map[string]any{}},
		Meta:   requestMetaForTest("pg-feishu-key"),
	}
	result, err := service.SendCard(ctx, authValue, input)
	if err != nil {
		t.Fatal(err)
	}
	if result.Card.CardType != feishucards.CardType || result.Card.SchemaVersion != feishucards.SchemaVersion {
		t.Fatalf("Feishu card = %#v", result.Card)
	}
	var stored string
	if err := pool.QueryRow(ctx, `SELECT payload_json FROM workspace_cards WHERE id = $1`, result.Card.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal([]byte(stored), converted.PayloadJSON) {
		t.Fatalf("stored Feishu payload = %s, want %s", stored, converted.PayloadJSON)
	}
	wantHash, err := hashGatewayRequest(cardIdempotencyInput{
		ConversationID: input.ConversationID, CardType: feishucards.CardType, SchemaVersion: feishucards.SchemaVersion,
		FallbackText: converted.FallbackText, Payload: converted.Payload, RawPayload: converted.PayloadJSON,
	})
	if err != nil {
		t.Fatal(err)
	}
	var storedHash string
	if err := pool.QueryRow(ctx, `SELECT request_hash FROM workspace_agent_bot_idempotency WHERE bot_id = $1 AND operation = 'card.send' AND idempotency_key = $2`, authValue.BotID, input.IdempotencyKey).Scan(&storedHash); err != nil {
		t.Fatal(err)
	}
	if storedHash != wantHash {
		t.Fatalf("stored Feishu hash = %s, want %s", storedHash, wantHash)
	}

	updatedRaw := json.RawMessage(`{"elements":[{"tag":"markdown","content":"updated \ud800"}]}`)
	updated, err := feishucards.ConvertJSON(updatedRaw)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.UpdateCard(ctx, authValue, result.Card.ID, UpdateCardInput{
		ExpectedRevision: 1, Format: "feishu-card", RawFeishuCard: updatedRaw,
		Fields: map[string]any{"format": "feishu-card", "feishuCard": map[string]any{}},
		Meta:   requestMetaForTest("pg-feishu-update"),
	}); err != nil {
		t.Fatal(err)
	}
	var revision int64
	var fallback string
	if err := pool.QueryRow(ctx, `SELECT payload_json, revision, fallback_text FROM workspace_cards WHERE id = $1`, result.Card.ID).Scan(&stored, &revision, &fallback); err != nil {
		t.Fatal(err)
	}
	if stored != string(updated.PayloadJSON) || revision != 2 || fallback != updated.FallbackText {
		t.Fatalf("updated Feishu card = %s revision %d fallback %q", stored, revision, fallback)
	}

	otherRawToken := "dl_bot_" + strings.Repeat("o", 40)
	seedSecondBotForGatewayPG(t, ctx, pool, now, otherRawToken)
	otherAuth, err := service.Authenticate(ctx, "Bearer "+otherRawToken, TokenAuthOptions{SpaceID: DefaultSpaceID})
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.UpdateCard(ctx, otherAuth, result.Card.ID, UpdateCardInput{
		ExpectedRevision: 1, Format: "feishu-card", RawFeishuCard: raw,
		Fields: map[string]any{"format": "feishu-card", "feishuCard": map[string]any{}},
		Meta:   requestMetaForTest("pg-feishu-owner-reject"),
	})
	if !isCode(err, CodeCardNotFound) {
		t.Fatalf("non-owner Feishu update error = %v", err)
	}
	var auditCount int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM audit_logs WHERE actor_user_id = $1 AND action = 'bot.gateway.card.update' AND target_id = $2 AND result = 'rejected' AND reason = $3`, otherAuth.UserID, result.Card.ID, CodeCardNotFound).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if auditCount != 1 {
		t.Fatalf("non-owner rejection audit count = %d, want 1", auditCount)
	}
}

func seedSecondBotForGatewayPG(t *testing.T, ctx context.Context, pool *pgxpool.Pool, now time.Time, rawToken string) {
	t.Helper()
	// This helper is intentionally kept to synthetic owner/bot rows only; it
	// never logs or persists the raw token, only its gateway hash.
	queries := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users (id, github_id, github_login, email, display_name, nickname, kind, created_at, last_login_at)
			VALUES
			('user-other-owner-botgateway', 'github-other-owner-botgateway', 'other-owner-botgateway', 'other-owner@example.test', 'Other Owner', 'Other Owner', 'human', $1, $1),
			('user-other-botgateway', 'github-other-botgateway', 'other-botgateway', NULL, 'Other Bot', 'Other Bot', 'bot', $1, NULL)`, []any{now}},
		{`INSERT INTO space_members (space_id, user_id, role, joined_at)
			VALUES ($1, 'user-other-owner-botgateway', 'owner', $2), ($1, 'user-other-botgateway', 'member', $2)`, []any{DefaultSpaceID, now}},
		{`INSERT INTO workspace_agent_bots
			(id, space_id, owner_user_id, bot_user_id, name, name_normalized, visibility_policy, conversation_policy, trigger_policy, status, created_at, updated_at)
			VALUES ('bot-other-botgateway', $1, 'user-other-owner-botgateway', 'user-other-botgateway', 'Other Gateway Bot', 'other gateway bot', 'private', 'direct-only', 'mention-or-command', 'active', $2, $2)`, []any{DefaultSpaceID, now}},
		{`INSERT INTO workspace_agent_bot_tokens (id, bot_id, space_id, token_hash, scopes_json, created_at)
			VALUES ('token-other-botgateway', 'bot-other-botgateway', $1, $2, $3, $4)`, []any{DefaultSpaceID, HashToken(rawToken), `[
			"cards:write"
		]`, now}},
	}
	for _, item := range queries {
		if _, err := pool.Exec(ctx, item.query, item.args...); err != nil {
			t.Fatal(err)
		}
	}
}
