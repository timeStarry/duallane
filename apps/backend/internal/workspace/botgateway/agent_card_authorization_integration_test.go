//go:build postgres_integration

package botgateway

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workspacecards "github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	workspacemessages "github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

type agentCardAuthorizationFixture struct {
	*agentPlatformPGFixture
	cards  *workspacecards.Service
	cardTx CardGateway
}

func openAgentCardAuthorizationFixture(t *testing.T) *agentCardAuthorizationFixture {
	t.Helper()
	fixture := openAgentPlatformPGFixture(t)
	agentPlatformSetTokenScopes(t, fixture, fixture.auth.TokenID, []string{
		ScopeMessagesReadTrigger,
		ScopeMessagesReadContext,
		ScopeMessagesSend,
		ScopeCardsWrite,
	})

	messageRepository := workspacemessages.NewPGRepository(fixture.pool)
	cardRepository := workspacecards.NewPGRepository(fixture.pool)
	registry, err := workspacecards.NewRegistry()
	if err != nil {
		t.Fatal(err)
	}
	messageService := workspacemessages.NewService(workspacemessages.ServiceOptions{
		Repository: messageRepository,
		SpaceID:    DefaultSpaceID,
		Now:        func() time.Time { return fixture.now },
		AllowBots:  true,
	})
	cardService := workspacecards.NewService(workspacecards.ServiceOptions{
		Repository: cardRepository,
		Registry:   registry,
		SpaceID:    DefaultSpaceID,
		Now:        func() time.Time { return fixture.now },
	})
	adapters := NewRuntimeAdapters(RuntimeAdapterOptions{Messages: messageService, Cards: cardService})
	gatewayRepository := NewPGRepositoryWithDomainTransactions(fixture.pool, DomainTransactionOptions{
		Messages: messageRepository,
		Cards:    cardRepository,
	})
	gateway := NewService(ServiceOptions{
		Repository:    gatewayRepository,
		MessageWriter: adapters.MessageWriter,
		CardGateway:   adapters.CardGateway,
		SpaceID:       DefaultSpaceID,
		Now:           func() time.Time { return fixture.now },
	})
	authValue, err := gateway.Authenticate(fixture.ctx, "Bearer "+agentPlatformRawToken, TokenAuthOptions{SpaceID: DefaultSpaceID})
	if err != nil {
		t.Fatal(err)
	}
	fixture.service = gateway
	fixture.auth = authValue
	return &agentCardAuthorizationFixture{agentPlatformPGFixture: fixture, cards: cardService, cardTx: adapters.CardGateway}
}

func createTwoCardTasks(t *testing.T, fixture *agentCardAuthorizationFixture) (*AgentTask, *AgentTask) {
	t.Helper()
	agentPlatformQueueSeedEvent(t, fixture.agentPlatformPGFixture)
	firstResult, err := fixture.service.CreateAgentTask(fixture.ctx, fixture.auth, "event-botgateway")
	if err != nil {
		t.Fatal(err)
	}
	firstTask := agentPlatformTask(firstResult)
	if firstTask == nil {
		t.Fatal("missing first card task")
	}
	agentPlatformInsertMessageEventDelivery(t, fixture.agentPlatformPGFixture, agentPlatformEventInput{
		BotID: fixture.auth.BotID, ConversationID: firstTask.ConversationID, AuthorID: fixture.auth.OwnerUserID,
		MessageID: "message-agent-card-task-b", EventID: "event-agent-card-task-b", DeliveryID: "delivery-agent-card-task-b",
		Sequence: 2, Text: "第二个会话任务", CreatedAt: fixture.now.Add(-30 * time.Second),
	})
	secondResult, err := fixture.service.CreateAgentTask(fixture.ctx, fixture.auth, "event-agent-card-task-b")
	if err != nil {
		t.Fatal(err)
	}
	secondTask := agentPlatformTask(secondResult)
	if secondTask == nil {
		t.Fatal("missing second card task")
	}
	if firstTask.RootTaskID == secondTask.RootTaskID || firstTask.ConversationID != secondTask.ConversationID {
		t.Fatalf("task roots/conversations = %s/%s and %s/%s", firstTask.RootTaskID, firstTask.ConversationID, secondTask.RootTaskID, secondTask.ConversationID)
	}
	return firstTask, secondTask
}

func sendCardForTask(t *testing.T, fixture *agentCardAuthorizationFixture, task *AgentTask, key string) SendCardResult {
	t.Helper()
	result, err := fixture.service.SendCard(WithAgentTaskID(fixture.ctx, task.ID), fixture.auth, SendCardInput{
		ConversationID:  task.ConversationID,
		ClientMessageID: key + "-message",
		IdempotencyKey:  key,
		CardType:        "future.poll",
		SchemaVersion:   1,
		FallbackText:    "任务卡片",
		Payload:         map[string]any{"value": "initial"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Card.ID == "" || result.Card.Revision != 1 || result.Message.ID == "" {
		t.Fatalf("task card result = %#v", result)
	}
	var originTaskID string
	if err := fixture.pool.QueryRow(fixture.ctx, `
		SELECT task_id FROM workspace_agent_message_origins WHERE message_id = $1
	`, result.Message.ID).Scan(&originTaskID); err != nil {
		t.Fatal(err)
	}
	if originTaskID != task.ID {
		t.Fatalf("card message origin = %q, want %q", originTaskID, task.ID)
	}
	return result
}

func getCardRecord(t *testing.T, fixture *agentCardAuthorizationFixture, cardID string) *workspacecards.CardRecord {
	t.Helper()
	record, err := fixture.cards.Repository().GetCard(fixture.ctx, fixture.auth.SpaceID, cardID)
	if err != nil {
		t.Fatal(err)
	}
	if record == nil {
		t.Fatalf("card %s disappeared", cardID)
	}
	return record
}

func taskWrites(t *testing.T, fixture *agentCardAuthorizationFixture, taskID string) int {
	t.Helper()
	var writes int
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT writes_used FROM workspace_agent_tasks WHERE id = $1`, taskID).Scan(&writes); err != nil {
		t.Fatal(err)
	}
	return writes
}

func TestPGBotAgentCardUpdateCannotCrossTaskWithinConversation(t *testing.T) {
	fixture := openAgentCardAuthorizationFixture(t)
	taskA, taskB := createTwoCardTasks(t, fixture)
	created := sendCardForTask(t, fixture, taskA, "agent-card-cross-task")
	writesBefore := taskWrites(t, fixture, taskB.ID)
	_, err := fixture.service.UpdateCard(WithAgentTaskID(fixture.ctx, taskB.ID), fixture.auth, created.Card.ID, UpdateCardInput{
		ExpectedRevision: created.Card.Revision,
		Payload:          map[string]any{"value": "task B must not update task A"},
	})
	if err == nil {
		t.Fatal("different task updated an old card in the same conversation")
	}
	if !isCode(err, "task.authorization_required") {
		t.Fatalf("cross-task card update error = %v", err)
	}
	if got := getCardRecord(t, fixture, created.Card.ID).Revision; got != created.Card.Revision {
		t.Fatalf("cross-task update changed revision to %d", got)
	}
	if got := taskWrites(t, fixture, taskB.ID); got != writesBefore {
		t.Fatalf("cross-task rejection consumed task budget: before=%d after=%d", writesBefore, got)
	}
}

func TestPGBotAgentCardReferenceCannotLaunderCreationTask(t *testing.T) {
	fixture := openAgentCardAuthorizationFixture(t)
	taskA, taskB := createTwoCardTasks(t, fixture)
	created := sendCardForTask(t, fixture, taskA, "agent-card-reference-source")
	block := created.Card.Block
	if block == nil {
		t.Fatal("missing card block")
	}
	// A public reference can be shared within the authorized conversation. It
	// cannot grant the new task ownership of the underlying mutable card.
	_, err := fixture.service.SendMessage(WithAgentTaskID(fixture.ctx, taskB.ID), fixture.auth, SendMessageInput{
		ConversationID: taskB.ConversationID, ClientMessageID: "agent-card-reference-message", IdempotencyKey: "agent-card-reference",
		Content: MessageContent{Format: MessageContentFormat, PlainText: created.Card.FallbackText, Blocks: []map[string]any{block}},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = fixture.service.UpdateCard(WithAgentTaskID(fixture.ctx, taskB.ID), fixture.auth, created.Card.ID, UpdateCardInput{ExpectedRevision: created.Card.Revision, Payload: map[string]any{"value": "must not replace"}})
	if !isCode(err, "task.authorization_required") {
		t.Fatalf("re-reference granted card ownership: %v", err)
	}
	if got := getCardRecord(t, fixture, created.Card.ID).Revision; got != created.Card.Revision {
		t.Fatalf("card revision changed: %d", got)
	}
}

func TestPGBotAgentCardReferenceCannotExposeResourceScopedCard(t *testing.T) {
	fixture := openAgentCardAuthorizationFixture(t)
	taskA, taskB := createTwoCardTasks(t, fixture)
	created := sendCardForTask(t, fixture, taskA, "agent-card-resource-scoped")
	if _, err := fixture.pool.Exec(fixture.ctx, `UPDATE workspace_cards SET visibility_scope='resource',resource_type='topic',resource_id='private-topic' WHERE id=$1`, created.Card.ID); err != nil {
		t.Fatal(err)
	}
	for index, task := range []*AgentTask{taskA, taskB} {
		_, err := fixture.service.SendMessage(WithAgentTaskID(fixture.ctx, task.ID), fixture.auth, SendMessageInput{
			ConversationID: task.ConversationID, ClientMessageID: "resource-card-reference-" + strconv.Itoa(index), IdempotencyKey: "resource-card-reference-" + strconv.Itoa(index),
			Content: MessageContent{Format: MessageContentFormat, PlainText: created.Card.FallbackText, Blocks: []map[string]any{created.Card.Block}},
		})
		if !isCode(err, "task.authorization_required") {
			t.Fatalf("resource card escaped to ordinary message: %v", err)
		}
	}
}

func TestPGBotAgentCardUpdateRejectsStaleRevision(t *testing.T) {
	fixture := openAgentCardAuthorizationFixture(t)
	taskA, _ := createTwoCardTasks(t, fixture)
	created := sendCardForTask(t, fixture, taskA, "agent-card-stale-revision")
	if _, err := fixture.cards.UpdateCustomBotCard(fixture.ctx, workspacecards.CustomBotUpdateInput{
		ActorID:          fixture.auth.UserID,
		SpaceID:          fixture.auth.SpaceID,
		CardID:           created.Card.ID,
		BotID:            fixture.auth.BotID,
		BotUserID:        fixture.auth.UserID,
		ExpectedRevision: created.Card.Revision,
		Payload:          map[string]any{"value": "external update"},
	}); err != nil {
		t.Fatal(err)
	}
	writesBefore := taskWrites(t, fixture, taskA.ID)
	_, err := fixture.service.UpdateCard(WithAgentTaskID(fixture.ctx, taskA.ID), fixture.auth, created.Card.ID, UpdateCardInput{
		ExpectedRevision: created.Card.Revision,
		Payload:          map[string]any{"value": "stale task update"},
	})
	if err == nil {
		t.Fatal("stale card revision unexpectedly succeeded")
	}
	if !isCode(err, CodeCardRevisionConflict) {
		t.Fatalf("stale revision error = %v", err)
	}
	if got := getCardRecord(t, fixture, created.Card.ID).Revision; got != created.Card.Revision+1 {
		t.Fatalf("stale update changed revision to %d", got)
	}
	if got := taskWrites(t, fixture, taskA.ID); got != writesBefore {
		t.Fatalf("stale rejection consumed task budget: before=%d after=%d", writesBefore, got)
	}
	var idempotencyRows int
	if err := fixture.pool.QueryRow(fixture.ctx, `
		SELECT COUNT(*) FROM workspace_agent_bot_idempotency
		WHERE bot_id = $1 AND operation = 'card.update' AND idempotency_key = $2
	`, fixture.auth.BotID, agentCardOperationKey(created.Card.ID, created.Card.Revision)).Scan(&idempotencyRows); err != nil {
		t.Fatal(err)
	}
	if idempotencyRows != 0 {
		t.Fatalf("stale update left idempotency row: %d", idempotencyRows)
	}
}

type revokeAfterCardUpdateGateway struct {
	inner   CardGateway
	pool    *pgxpool.Pool
	tokenID string
	at      time.Time
}

func (g *revokeAfterCardUpdateGateway) CreateCustomBotCard(ctx context.Context, input CardCreateRequest) (Card, error) {
	return g.inner.CreateCustomBotCard(ctx, input)
}

func (g *revokeAfterCardUpdateGateway) UpdateCustomBotCard(ctx context.Context, input CardUpdateRequest) (Card, error) {
	return g.inner.UpdateCustomBotCard(ctx, input)
}

func (g *revokeAfterCardUpdateGateway) UpdateCustomBotCardInTx(ctx context.Context, tx Tx, input CardUpdateRequest) (Card, error) {
	updater, ok := g.inner.(interface {
		UpdateCustomBotCardInTx(context.Context, Tx, CardUpdateRequest) (Card, error)
	})
	if !ok {
		return Card{}, errors.New("transactional card updater is required")
	}
	card, err := updater.UpdateCustomBotCardInTx(ctx, tx, input)
	if err != nil {
		return Card{}, err
	}
	// Inject a final authorization failure in the same transaction. An external
	// revocation waits for the authorization row lock and cannot interpose here.
	transaction, ok := tx.(*pgTx)
	if !ok {
		return Card{}, errors.New("PostgreSQL transaction is required")
	}
	if _, err := transaction.tx.Exec(ctx, `
		UPDATE workspace_agent_bot_tokens SET revoked_at = $1 WHERE id = $2
	`, g.at, g.tokenID); err != nil {
		return Card{}, err
	}
	return card, nil
}

func (g *revokeAfterCardUpdateGateway) InvalidateCustomBotCard(ctx context.Context, input CardUpdateRequest) (Card, error) {
	return g.inner.InvalidateCustomBotCard(ctx, input)
}

func (g *revokeAfterCardUpdateGateway) ValidateMessageCardReference(ctx context.Context, actorID, conversationID string, block map[string]any) error {
	return g.inner.ValidateMessageCardReference(ctx, actorID, conversationID, block)
}

func TestPGBotAgentCardUpdateRollsBackOnFinalAuthorizationFailure(t *testing.T) {
	fixture := openAgentCardAuthorizationFixture(t)
	taskA, _ := createTwoCardTasks(t, fixture)
	created := sendCardForTask(t, fixture, taskA, "agent-card-update-rollback")
	writesBefore := taskWrites(t, fixture, taskA.ID)
	revokingGateway := &revokeAfterCardUpdateGateway{
		inner:   fixture.cardTx,
		pool:    fixture.pool,
		tokenID: fixture.auth.TokenID,
		at:      fixture.now.Add(time.Second),
	}
	transactionalService := NewService(ServiceOptions{
		Repository:    fixture.service.repo,
		MessageWriter: fixture.service.messageWriter,
		CardGateway:   revokingGateway,
		SpaceID:       DefaultSpaceID,
		Now:           func() time.Time { return fixture.now },
	})
	_, err := transactionalService.UpdateCard(WithAgentTaskID(fixture.ctx, taskA.ID), fixture.auth, created.Card.ID, UpdateCardInput{
		ExpectedRevision: created.Card.Revision,
		Payload:          map[string]any{"value": "must roll back"},
	})
	if err == nil {
		t.Fatal("token revocation after card update unexpectedly committed")
	}
	if !isCode(err, "task.invalidated") && !isCode(err, CodeInvalidToken) {
		t.Fatalf("rollback authorization error = %v", err)
	}
	record := getCardRecord(t, fixture, created.Card.ID)
	if record.Revision != created.Card.Revision || !strings.Contains(string(record.PayloadJSON), "initial") {
		t.Fatalf("card mutation was not rolled back: revision=%d payload=%s", record.Revision, record.PayloadJSON)
	}
	if got := taskWrites(t, fixture, taskA.ID); got != writesBefore {
		t.Fatalf("rollback consumed task budget: before=%d after=%d", writesBefore, got)
	}
	var idempotencyRows int
	if err := fixture.pool.QueryRow(fixture.ctx, `
		SELECT COUNT(*) FROM workspace_agent_bot_idempotency
		WHERE bot_id = $1 AND operation = 'card.update' AND idempotency_key = $2
	`, fixture.auth.BotID, agentCardOperationKey(created.Card.ID, created.Card.Revision)).Scan(&idempotencyRows); err != nil {
		t.Fatal(err)
	}
	if idempotencyRows != 0 {
		t.Fatalf("rolled-back update left idempotency row: %d", idempotencyRows)
	}
}

func agentCardOperationKey(cardID string, revision int64) string {
	sum := sha256.Sum256([]byte(cardID + ":" + strconv.FormatInt(revision, 10)))
	return "card_" + hex.EncodeToString(sum[:])
}
