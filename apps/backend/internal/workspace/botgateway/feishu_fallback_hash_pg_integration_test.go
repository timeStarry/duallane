//go:build postgres_integration

package botgateway

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"

	workspacecards "github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/feishucards"
	workspacemessages "github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

func TestPGGatewayFeishuFallbackHashReplaysNodeRaw(t *testing.T) {
	ctx, pool := openBotGatewayAtomicityDatabase(t)
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	rawToken := "dl_bot_" + strings.Repeat("g", 40)
	if _, err := pool.Exec(ctx, `UPDATE workspace_agent_bot_tokens SET token_hash = $1, scopes_json = $2 WHERE id = 'token-botgateway'`, HashToken(rawToken), `["cards:write","messages:send"]`); err != nil {
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

	raw := json.RawMessage(`{"header":{"title":{"tag":"plain_text","content":"\ud800 title"}},"elements":[{"tag":"div","text":{"tag":"plain_text","content":"body"}}]}`)
	converted, err := feishucards.ConvertJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	rawFallback := json.RawMessage(`"\ud800 explicit"`)
	input := SendCardInput{
		ConversationID: "conversation-botgateway", ClientMessageID: "pg-feishu-fallback-message", IdempotencyKey: "pg-feishu-fallback-key",
		Format: "feishu-card", RawFeishuCard: raw, RawFallbackText: rawFallback,
		Fields: map[string]any{"format": "feishu-card", "feishuCard": map[string]any{}, "fallbackText": "\ufffd explicit"},
	}
	created, err := service.SendCard(ctx, authValue, input)
	if err != nil {
		t.Fatal(err)
	}
	if created.Card.FallbackText != "\ufffd explicit" {
		t.Fatalf("created fallback = %q, want U+FFFD replacement", created.Card.FallbackText)
	}

	var storedPayload, storedFallback, storedHash string
	if err := pool.QueryRow(ctx, `SELECT payload_json, fallback_text FROM workspace_cards WHERE id = $1`, created.Card.ID).Scan(&storedPayload, &storedFallback); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal([]byte(storedPayload), converted.PayloadJSON) {
		t.Fatalf("stored payload = %s, want %s", storedPayload, converted.PayloadJSON)
	}
	if storedFallback != "\ufffd explicit" {
		t.Fatalf("stored fallback = %q, want replacement-normalized explicit value", storedFallback)
	}
	if err := pool.QueryRow(ctx, `SELECT request_hash FROM workspace_agent_bot_idempotency WHERE bot_id = $1 AND operation = 'card.send' AND idempotency_key = $2`, authValue.BotID, input.IdempotencyKey).Scan(&storedHash); err != nil {
		t.Fatal(err)
	}
	_, hashFallbackJSON, err := normalizeRawFallbackJSON(rawFallback)
	if err != nil {
		t.Fatal(err)
	}
	wantHash, err := hashGatewayRequest(cardIdempotencyInput{
		ConversationID: "conversation-botgateway", CardType: converted.CardType, SchemaVersion: converted.SchemaVersion,
		FallbackText: "\ufffd explicit", Payload: converted.Payload, RawPayload: converted.PayloadJSON,
		HashFallbackJSON: hashFallbackJSON,
	})
	if err != nil {
		t.Fatal(err)
	}
	if storedHash != wantHash {
		t.Fatalf("stored Node-compatible hash = %s, want %s", storedHash, wantHash)
	}

	var before [4]int
	if err := pool.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM workspace_cards), (SELECT COUNT(*) FROM messages), (SELECT COUNT(*) FROM workspace_events), (SELECT COUNT(*) FROM audit_logs)`).Scan(&before[0], &before[1], &before[2], &before[3]); err != nil {
		t.Fatal(err)
	}
	replayed, err := service.SendCard(ctx, authValue, input)
	if err != nil {
		t.Fatal(err)
	}
	if replayed.Card.ID != created.Card.ID || replayed.Message.ID != created.Message.ID {
		t.Fatalf("replay result = %#v, want original card/message", replayed)
	}
	var after [4]int
	if err := pool.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM workspace_cards), (SELECT COUNT(*) FROM messages), (SELECT COUNT(*) FROM workspace_events), (SELECT COUNT(*) FROM audit_logs)`).Scan(&after[0], &after[1], &after[2], &after[3]); err != nil {
		t.Fatal(err)
	}
	if after != before {
		t.Fatalf("replay changed domain counts: before=%v after=%v", before, after)
	}
}
