//go:build postgres_integration

package botgateway

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	workspacemessages "github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

// TestPGGatewayMessageSendRequiresBotEnabledMessageService records the
// composition boundary behind the browser's 401: token authentication and
// conversation authorization succeed, then the messages domain rejects the
// bot actor unless its explicitly composed service has AllowBots enabled.
// The successful half uses the same gateway transaction and verifies that
// concurrent duplicate delivery creates one message, one event, one audit,
// and one idempotency row.
func TestPGGatewayMessageSendRequiresBotEnabledMessageService(t *testing.T) {
	ctx, pool := openBotGatewayAtomicityDatabase(t)
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	rawToken := "dl_bot_" + strings.Repeat("m", 40)
	if _, err := pool.Exec(ctx, `UPDATE workspace_agent_bot_tokens SET token_hash = $1, scopes_json = $2 WHERE id = 'token-botgateway'`, HashToken(rawToken), `[
		"messages:send"
	]`); err != nil {
		t.Fatal(err)
	}

	messageRepository := workspacemessages.NewPGRepository(pool)
	gatewayRepository := NewPGRepositoryWithDomainTransactions(pool, DomainTransactionOptions{Messages: messageRepository})
	base := NewService(ServiceOptions{Repository: gatewayRepository, SpaceID: DefaultSpaceID, Now: func() time.Time { return now }})
	authValue, err := base.Authenticate(ctx, "Bearer "+rawToken, TokenAuthOptions{SpaceID: DefaultSpaceID})
	if err != nil {
		t.Fatal(err)
	}
	input := SendMessageInput{
		ConversationID: "conversation-botgateway", ClientMessageID: "browser-bot-message", IdempotencyKey: "browser-bot-message-key",
		Text: "synthetic bot gateway message", Meta: requestMetaForTest("browser-bot-message-key"),
	}

	blockedMessages := workspacemessages.NewService(workspacemessages.ServiceOptions{
		Repository: messageRepository, SpaceID: DefaultSpaceID, Now: func() time.Time { return now }, AllowBots: false,
	})
	blockedAdapters := NewRuntimeAdapters(RuntimeAdapterOptions{Messages: blockedMessages})
	blockedGateway := NewService(ServiceOptions{
		Repository: gatewayRepository, MessageWriter: blockedAdapters.MessageWriter,
		SpaceID: DefaultSpaceID, Now: func() time.Time { return now },
	})
	if _, err := blockedGateway.SendMessage(ctx, authValue, input); !isCode(err, "auth.identity_forbidden") {
		t.Fatalf("AllowBots=false message error = %v", err)
	}
	assertPGGatewayMessageCounts(t, ctx, pool, input, 0, 0, 0, 0)

	allowedMessages := workspacemessages.NewService(workspacemessages.ServiceOptions{
		Repository: messageRepository, SpaceID: DefaultSpaceID, Now: func() time.Time { return now }, AllowBots: true,
	})
	allowedAdapters := NewRuntimeAdapters(RuntimeAdapterOptions{Messages: allowedMessages})
	allowedGateway := NewService(ServiceOptions{
		Repository: gatewayRepository, MessageWriter: allowedAdapters.MessageWriter,
		SpaceID: DefaultSpaceID, Now: func() time.Time { return now },
	})
	results := make(chan SendMessageResult, 2)
	errors := make(chan error, 2)
	var wait sync.WaitGroup
	for index := 0; index < 2; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			result, sendErr := allowedGateway.SendMessage(ctx, authValue, input)
			results <- result
			errors <- sendErr
		}()
	}
	wait.Wait()
	close(results)
	close(errors)
	var first SendMessageResult
	for result := range results {
		if first.Message.ID == "" {
			first = result
		}
		if result.Message.ID == "" || result.Message.ID != first.Message.ID {
			t.Fatalf("concurrent message result = %#v, first=%#v", result, first)
		}
	}
	for sendErr := range errors {
		if sendErr != nil {
			t.Fatalf("concurrent bot message send error = %v", sendErr)
		}
	}
	assertPGGatewayMessageCounts(t, ctx, pool, input, 1, 1, 1, 1)
}

func assertPGGatewayMessageCounts(t *testing.T, ctx context.Context, pool *pgxpool.Pool, input SendMessageInput, messages, events, audits, idempotency int) {
	t.Helper()
	var messageCount, eventCount, auditCount, idempotencyCount int
	var messageID string
	if err := pool.QueryRow(ctx, `SELECT COUNT(*), COALESCE(MAX(id), '') FROM messages WHERE client_message_id = $1`, input.ClientMessageID).Scan(&messageCount, &messageID); err != nil {
		t.Fatal(err)
	}
	if messageID != "" {
		if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM workspace_events WHERE type = 'message.created' AND target_type = 'message' AND target_id = $1`, messageID).Scan(&eventCount); err != nil {
			t.Fatal(err)
		}
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM audit_logs WHERE action = 'message.create' AND target_type = 'conversation' AND target_id = $1 AND request_id = $2`, input.ConversationID, input.Meta.RequestID).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM workspace_agent_bot_idempotency WHERE operation = 'message.send' AND idempotency_key = $1`, input.IdempotencyKey).Scan(&idempotencyCount); err != nil {
		t.Fatal(err)
	}
	if messageCount != messages || eventCount != events || auditCount != audits || idempotencyCount != idempotency {
		t.Fatalf("message counts for %q = messages:%d events:%d audits:%d idempotency:%d, want %d/%d/%d/%d", input.IdempotencyKey, messageCount, eventCount, auditCount, idempotencyCount, messages, events, audits, idempotency)
	}
}

func requestMetaForTest(requestID string) auth.RequestMeta {
	return auth.RequestMeta{RequestID: requestID, IPAddress: "127.0.0.1", UserAgent: "botgateway-pg-test"}
}
