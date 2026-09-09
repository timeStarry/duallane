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
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	workspacecards "github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	workspacemessages "github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

func TestPGBotGatewayCardMessageWritesRollbackTogether(t *testing.T) {
	ctx, pool := openBotGatewayAtomicityDatabase(t)
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	rawToken := "dl_bot_" + strings.Repeat("b", 40)
	scopes, err := json.Marshal([]string{ScopeMessagesSend, ScopeCardsWrite})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE workspace_agent_bot_tokens SET token_hash = $1, scopes_json = $2 WHERE id = $3`, HashToken(rawToken), string(scopes), "token-botgateway"); err != nil {
		t.Fatal(err)
	}

	messageRepository := workspacemessages.NewPGRepository(pool)
	cardRepository := workspacecards.NewPGRepository(pool)
	registry, err := workspacecards.NewRegistry()
	if err != nil {
		t.Fatal(err)
	}
	messageService := workspacemessages.NewService(workspacemessages.ServiceOptions{
		Repository: messageRepository, SpaceID: DefaultSpaceID, Now: func() time.Time { return now }, AllowBots: true,
	})
	cardService := workspacecards.NewService(workspacecards.ServiceOptions{
		Repository: cardRepository, Registry: registry, SpaceID: DefaultSpaceID, Now: func() time.Time { return now },
	})
	gatewayRepository := NewPGRepositoryWithDomainTransactions(pool, DomainTransactionOptions{Messages: messageRepository, Cards: cardRepository})
	adapters := NewRuntimeAdapters(RuntimeAdapterOptions{Messages: messageService, Cards: cardService})
	service := NewService(ServiceOptions{
		Repository: gatewayRepository, MessageWriter: adapters.MessageWriter, CardGateway: adapters.CardGateway,
		SpaceID: DefaultSpaceID, Now: func() time.Time { return now }, IDFactory: func() (string, error) { return "fixed", nil },
	})
	authValue, err := service.Authenticate(ctx, "Bearer "+rawToken, TokenAuthOptions{SpaceID: DefaultSpaceID})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := pool.Exec(ctx, `
        INSERT INTO workspace_agent_bot_idempotency
          (id, bot_id, token_id, space_id, operation, idempotency_key, request_hash, response_status, response_json, created_at, expires_at)
        VALUES ('bid_fixed', 'bot-botgateway', 'token-botgateway', $1, 'preexisting', 'preexisting', 'preexisting', 200, '{}', $2, $3)
	`, DefaultSpaceID, now, now.Add(24*time.Hour)); err != nil {
		t.Fatal(err)
	}

	// A domain audit ID collision must roll back the card, its event, and the
	// outer gateway idempotency row. This exercises the audit failure path after
	// the card domain has already performed its insert and event write.
	const conflictingAuditID = "audit-atomic-fixed"
	insertConflictingAudit(t, ctx, pool, conflictingAuditID, now)
	auditCardRepository := workspacecards.NewPGRepository(pool, func() (string, error) { return conflictingAuditID, nil })
	auditCardService := workspacecards.NewService(workspacecards.ServiceOptions{
		Repository: auditCardRepository, Registry: registry, SpaceID: DefaultSpaceID, Now: func() time.Time { return now },
	})
	auditCardGatewayRepository := NewPGRepositoryWithDomainTransactions(pool, DomainTransactionOptions{Messages: messageRepository, Cards: auditCardRepository})
	auditCardAdapters := NewRuntimeAdapters(RuntimeAdapterOptions{Messages: messageService, Cards: auditCardService})
	auditCardServiceGateway := NewService(ServiceOptions{
		Repository: auditCardGatewayRepository, MessageWriter: auditCardAdapters.MessageWriter, CardGateway: auditCardAdapters.CardGateway,
		SpaceID: DefaultSpaceID, Now: func() time.Time { return now },
	})
	auditCardInput := atomicCardInput("atomic-audit-card", "atomic-audit-card-message")
	if _, err := auditCardServiceGateway.SendCard(ctx, authValue, auditCardInput); err == nil {
		t.Fatal("card audit collision unexpectedly succeeded")
	}
	assertAtomicityCounts(t, ctx, pool, auditCardInput.IdempotencyKey, auditCardInput.ClientMessageID, 0, 0, 0, 0, 0)
	if _, err := pool.Exec(ctx, `DELETE FROM audit_logs WHERE id = $1`, conflictingAuditID); err != nil {
		t.Fatal(err)
	}

	// The message audit is also deliberately failed after the card and message
	// event writes. The same aggregate transaction must remove every write.
	insertConflictingAudit(t, ctx, pool, conflictingAuditID, now)
	auditMessageRepository := workspacemessages.NewPGRepository(pool, func() (string, error) { return conflictingAuditID, nil })
	auditMessageService := workspacemessages.NewService(workspacemessages.ServiceOptions{
		Repository: auditMessageRepository, SpaceID: DefaultSpaceID, Now: func() time.Time { return now }, AllowBots: true,
	})
	auditMessageGatewayRepository := NewPGRepositoryWithDomainTransactions(pool, DomainTransactionOptions{Messages: auditMessageRepository, Cards: cardRepository})
	auditMessageAdapters := NewRuntimeAdapters(RuntimeAdapterOptions{Messages: auditMessageService, Cards: cardService})
	auditMessageServiceGateway := NewService(ServiceOptions{
		Repository: auditMessageGatewayRepository, MessageWriter: auditMessageAdapters.MessageWriter, CardGateway: auditMessageAdapters.CardGateway,
		SpaceID: DefaultSpaceID, Now: func() time.Time { return now },
	})
	auditMessageInput := atomicCardInput("atomic-audit-message", "atomic-audit-message-message")
	if _, err := auditMessageServiceGateway.SendCard(ctx, authValue, auditMessageInput); err == nil {
		t.Fatal("message audit collision unexpectedly succeeded")
	}
	assertAtomicityCounts(t, ctx, pool, auditMessageInput.IdempotencyKey, auditMessageInput.ClientMessageID, 0, 0, 0, 0, 0)
	if _, err := pool.Exec(ctx, `DELETE FROM audit_logs WHERE id = $1`, conflictingAuditID); err != nil {
		t.Fatal(err)
	}

	failedInput := atomicCardInput("atomic-failure", "atomic-failure-message")
	if _, err := service.SendCard(ctx, authValue, failedInput); err == nil {
		t.Fatal("idempotency insert failure unexpectedly succeeded")
	}
	assertAtomicityCounts(t, ctx, pool, failedInput.IdempotencyKey, failedInput.ClientMessageID, 0, 0, 0, 0, 0)

	concurrentService := NewService(ServiceOptions{
		Repository: gatewayRepository, MessageWriter: adapters.MessageWriter, CardGateway: adapters.CardGateway,
		SpaceID: DefaultSpaceID, Now: func() time.Time { return now },
	})
	concurrentInput := atomicCardInput("atomic-concurrent", "atomic-concurrent-message")
	results := make(chan error, 2)
	var wait sync.WaitGroup
	for i := 0; i < 2; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, sendErr := concurrentService.SendCard(ctx, authValue, concurrentInput)
			results <- sendErr
		}()
	}
	wait.Wait()
	close(results)
	for sendErr := range results {
		if sendErr != nil {
			t.Fatalf("concurrent card send failed: %v", sendErr)
		}
	}
	assertAtomicityCounts(t, ctx, pool, concurrentInput.IdempotencyKey, concurrentInput.ClientMessageID, 1, 1, 1, 2, 2)
	if _, err := concurrentService.SendCard(ctx, authValue, concurrentInput); err != nil {
		t.Fatalf("idempotent replay failed: %v", err)
	}
	assertAtomicityCounts(t, ctx, pool, concurrentInput.IdempotencyKey, concurrentInput.ClientMessageID, 1, 1, 1, 2, 2)

	revokingGateway := &revokeAfterCardGateway{inner: adapters.CardGateway, pool: pool, tokenID: authValue.TokenID, at: now.Add(time.Second)}
	revokedService := NewService(ServiceOptions{
		Repository: gatewayRepository, MessageWriter: adapters.MessageWriter, CardGateway: revokingGateway,
		SpaceID: DefaultSpaceID, Now: func() time.Time { return now },
	})
	revocationInput := atomicCardInput("atomic-revoked", "atomic-revoked-message")
	if _, err := revokedService.SendCard(ctx, authValue, revocationInput); !isCode(err, CodeInvalidToken) {
		t.Fatalf("revoked transaction error = %v", err)
	}
	assertAtomicityCounts(t, ctx, pool, revocationInput.IdempotencyKey, revocationInput.ClientMessageID, 0, 0, 0, 0, 0)
}

func atomicCardInput(key, clientMessageID string) SendCardInput {
	return SendCardInput{
		ConversationID: "conversation-botgateway", ClientMessageID: clientMessageID, IdempotencyKey: key,
		CardType: "future.poll", SchemaVersion: 1, FallbackText: "atomic fallback",
		Payload: map[string]any{"value": "synthetic"}, Meta: auth.RequestMeta{RequestID: key},
	}
}

func insertConflictingAudit(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id string, now time.Time) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO audit_logs (id, space_id, actor_user_id, action, target_type, target_id, result, created_at)
		VALUES ($1, $2, 'user-botgateway', 'test.conflict', 'test', 'test', 'success', $3)
	`, id, DefaultSpaceID, now); err != nil {
		t.Fatal(err)
	}
}

func assertAtomicityCounts(t *testing.T, ctx context.Context, pool *pgxpool.Pool, idempotencyKey, clientMessageID string, cards, messages, idempotency, events, audits int) {
	t.Helper()
	var cardCount, messageCount, idempotencyCount, eventCount int
	sourceID := opaqueCardSourceID("bot-botgateway", idempotencyKey)
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM workspace_cards WHERE source_kind = 'custom_bot' AND source_id = $1`, sourceID).Scan(&cardCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM messages WHERE client_message_id = $1`, clientMessageID).Scan(&messageCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM workspace_agent_bot_idempotency WHERE bot_id = 'bot-botgateway' AND operation = 'card.send' AND idempotency_key = $1`, idempotencyKey).Scan(&idempotencyCount); err != nil {
		t.Fatal(err)
	}
	var cardID, messageID string
	if cardCount > 0 {
		if err := pool.QueryRow(ctx, `SELECT id FROM workspace_cards WHERE source_kind = 'custom_bot' AND source_id = $1`, sourceID).Scan(&cardID); err != nil {
			t.Fatal(err)
		}
		var count int
		if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM workspace_events WHERE type = 'card.created' AND target_type = 'workspace.card' AND target_id = $1`, cardID).Scan(&count); err != nil {
			t.Fatal(err)
		}
		eventCount += count
	}
	if messageCount > 0 {
		if err := pool.QueryRow(ctx, `SELECT id FROM messages WHERE client_message_id = $1`, clientMessageID).Scan(&messageID); err != nil {
			t.Fatal(err)
		}
		var count int
		if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM workspace_events WHERE type = 'message.created' AND target_type = 'message' AND target_id = $1`, messageID).Scan(&count); err != nil {
			t.Fatal(err)
		}
		eventCount += count
	}
	auditCount := 0
	if cardID != "" {
		var count int
		if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM audit_logs WHERE action = 'card.create' AND target_type = 'workspace.card' AND target_id = $1 AND request_id = $2`, cardID, idempotencyKey).Scan(&count); err != nil {
			t.Fatal(err)
		}
		auditCount += count
	}
	if messageID != "" {
		var count int
		if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM audit_logs WHERE action = 'message.create' AND target_type = 'conversation' AND target_id = 'conversation-botgateway' AND request_id = $1`, idempotencyKey).Scan(&count); err != nil {
			t.Fatal(err)
		}
		auditCount += count
	}
	if cardCount != cards || messageCount != messages || idempotencyCount != idempotency || eventCount != events || auditCount != audits {
		t.Fatalf("atomicity counts for key %q/client %q = cards:%d messages:%d idempotency:%d events:%d audits:%d, expected %d/%d/%d/%d/%d", idempotencyKey, clientMessageID, cardCount, messageCount, idempotencyCount, eventCount, auditCount, cards, messages, idempotency, events, audits)
	}
}

type revokeAfterCardGateway struct {
	inner   CardGateway
	pool    *pgxpool.Pool
	tokenID string
	at      time.Time
}

func (g *revokeAfterCardGateway) CreateCustomBotCard(ctx context.Context, input CardCreateRequest) (Card, error) {
	return g.inner.CreateCustomBotCard(ctx, input)
}

func (g *revokeAfterCardGateway) CreateCustomBotCardInTx(ctx context.Context, tx Tx, input CardCreateRequest) (Card, error) {
	transactional, ok := g.inner.(TransactionalCardGateway)
	if !ok {
		return Card{}, errors.New("transactional card gateway is required")
	}
	card, err := transactional.CreateCustomBotCardInTx(ctx, tx, input)
	if err != nil {
		return Card{}, err
	}
	_, err = g.pool.Exec(ctx, `UPDATE workspace_agent_bot_tokens SET revoked_at = $1 WHERE id = $2`, g.at, g.tokenID)
	if err != nil {
		return Card{}, err
	}
	return card, nil
}

func (g *revokeAfterCardGateway) UpdateCustomBotCard(ctx context.Context, input CardUpdateRequest) (Card, error) {
	return g.inner.UpdateCustomBotCard(ctx, input)
}

func (g *revokeAfterCardGateway) InvalidateCustomBotCard(ctx context.Context, input CardUpdateRequest) (Card, error) {
	return g.inner.InvalidateCustomBotCard(ctx, input)
}

func (g *revokeAfterCardGateway) ValidateMessageCardReference(ctx context.Context, actorID, conversationID string, block map[string]any) error {
	return g.inner.ValidateMessageCardReference(ctx, actorID, conversationID, block)
}

func (g *revokeAfterCardGateway) ValidateMessageCardReferenceInTx(ctx context.Context, tx Tx, actorID, conversationID string, block map[string]any) error {
	validator, ok := g.inner.(TransactionalCardReferenceValidator)
	if !ok {
		return errors.New("transactional card reference validator is required")
	}
	return validator.ValidateMessageCardReferenceInTx(ctx, tx, actorID, conversationID, block)
}

func openBotGatewayAtomicityDatabase(t *testing.T) (context.Context, *pgxpool.Pool) {
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
	schema := fmt.Sprintf("duallane_botgateway_atomic_%d", time.Now().UnixNano())
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
		Beginner: platformpostgres.NewMigrationBeginner(conn), Directory: migrationDirectory,
	}).Run(ctx); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	rawToken := "dl_bot_" + strings.Repeat("b", 40)
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
	return ctx, pool
}
