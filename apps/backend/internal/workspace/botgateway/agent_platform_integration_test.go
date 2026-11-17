//go:build postgres_integration

package botgateway

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/botpolicy"
	workspacemessages "github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

const agentPlatformRawToken = "dl_bot_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

var agentPlatformNow = time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)

type agentPlatformPGFixture struct {
	ctx     context.Context
	pool    *pgxpool.Pool
	service *Service
	auth    *Auth
	now     time.Time
}

func openAgentPlatformPGFixture(t *testing.T) *agentPlatformPGFixture {
	t.Helper()
	ctx, pool := openBotGatewayAtomicityDatabase(t)
	repository := NewPGRepository(pool)
	service := NewService(ServiceOptions{
		Repository: repository,
		SpaceID:    DefaultSpaceID,
		Now:        func() time.Time { return agentPlatformNow },
	})
	authValue, err := service.Authenticate(ctx, "Bearer "+agentPlatformRawToken, TokenAuthOptions{SpaceID: DefaultSpaceID})
	if err != nil {
		t.Fatal(err)
	}
	return &agentPlatformPGFixture{ctx: ctx, pool: pool, service: service, auth: authValue, now: agentPlatformNow}
}

func agentPlatformPolicy(allowBotTriggers bool, allowedBotIDs ...string) botpolicy.Policy {
	return botpolicy.Policy{
		Version:   botpolicy.Version,
		Discovery: botpolicy.DiscoveryPolicy{Audience: botpolicy.AudienceOwnerOnly},
		Direct:    botpolicy.DirectPolicy{Audience: botpolicy.AudienceOwnerOnly},
		Groups: botpolicy.GroupPolicy{
			Audience:         botpolicy.AudienceCurrentMembers,
			AllowBotTriggers: allowBotTriggers,
			AllowedBotIDs:    append([]string(nil), allowedBotIDs...),
		},
	}
}

func agentPlatformSetTokenScopes(t *testing.T, fixture *agentPlatformPGFixture, tokenID string, scopes []string) {
	t.Helper()
	encoded, err := json.Marshal(scopes)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.pool.Exec(fixture.ctx,
		`UPDATE workspace_agent_bot_tokens SET scopes_json = $1 WHERE id = $2`,
		string(encoded), tokenID,
	); err != nil {
		t.Fatal(err)
	}
}

func agentPlatformSetPolicy(t *testing.T, fixture *agentPlatformPGFixture, botID string, policy botpolicy.Policy, allowGroup bool) {
	t.Helper()
	encoded, err := json.Marshal(policy)
	if err != nil {
		t.Fatal(err)
	}
	allowGroupValue := 0
	if allowGroup {
		allowGroupValue = 1
	}
	if _, err := fixture.pool.Exec(fixture.ctx, `
		UPDATE workspace_agent_bot_settings
		SET access_policy = $1::jsonb, allow_group = $2, updated_at = $3
		WHERE bot_id = $4 AND space_id = $5
	`, string(encoded), allowGroupValue, fixture.now, botID, DefaultSpaceID); err != nil {
		t.Fatal(err)
	}
	if allowGroup {
		if _, err := fixture.pool.Exec(fixture.ctx, `
			UPDATE workspace_agent_bots SET conversation_policy = 'group-capable', updated_at = $1
			WHERE id = $2 AND space_id = $3
		`, fixture.now, botID, DefaultSpaceID); err != nil {
			t.Fatal(err)
		}
	}
}

func agentPlatformQueueSeedEvent(t *testing.T, fixture *agentPlatformPGFixture) {
	t.Helper()
	if _, err := fixture.pool.Exec(fixture.ctx, `
		INSERT INTO workspace_agent_bot_deliveries
		  (id, bot_id, space_id, sequence, event_id, event_type, conversation_id,
		   payload_json, status, created_at, expires_at)
		VALUES ('delivery-agent-platform-seed', 'bot-botgateway', $1, 1, 'event-botgateway',
		        'message.created', 'conversation-botgateway', '{}', 'queued', $2, $3)
	`, DefaultSpaceID, fixture.now, fixture.now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
}

func agentPlatformInsertConversation(t *testing.T, fixture *agentPlatformPGFixture, conversationID, kind string, memberIDs ...string) {
	t.Helper()
	if _, err := fixture.pool.Exec(fixture.ctx, `
		INSERT INTO conversations (id, space_id, type, title, direct_key, created_by, created_at)
		VALUES ($1, $2, $3, $4, NULL, 'user-owner-botgateway', $5)
	`, conversationID, DefaultSpaceID, kind, conversationID, fixture.now.Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	for _, memberID := range memberIDs {
		if _, err := fixture.pool.Exec(fixture.ctx, `
			INSERT INTO conversation_members (conversation_id, user_id, joined_at)
			VALUES ($1, $2, $3)
		`, conversationID, memberID, fixture.now.Add(-time.Minute)); err != nil {
			t.Fatal(err)
		}
	}
}

func agentPlatformAuthorizeGroup(t *testing.T, fixture *agentPlatformPGFixture, botID, conversationID string) {
	t.Helper()
	if _, err := fixture.pool.Exec(fixture.ctx, `
		INSERT INTO workspace_agent_bot_group_policies
		  (bot_id, space_id, conversation_id, status, invited_by, approved_by, created_at, updated_at)
		VALUES ($1, $2, $3, 'active', 'user-owner-botgateway', 'user-owner-botgateway', $4, $4)
	`, botID, DefaultSpaceID, conversationID, fixture.now); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.pool.Exec(fixture.ctx, `
		INSERT INTO workspace_agent_bot_context_grants
		  (grant_id, bot_id, space_id, conversation_id, allow_trigger, allow_context,
		   max_messages, granted_by, created_at, updated_at)
		VALUES ($1, $2, $3, $4, 1, 1, 50, 'user-owner-botgateway', $5, $5)
	`, "grant-"+botID+"-"+conversationID, botID, DefaultSpaceID, conversationID, fixture.now); err != nil {
		t.Fatal(err)
	}
}

func agentPlatformInsertMessageEventDelivery(t *testing.T, fixture *agentPlatformPGFixture, input agentPlatformEventInput) {
	t.Helper()
	blocks := input.Blocks
	if blocks == nil {
		blocks = []map[string]any{{"type": "text", "text": input.Text}}
	}
	content, err := json.Marshal(map[string]any{
		"format":    MessageContentFormat,
		"plainText": input.Text,
		"blocks":    blocks,
	})
	if err != nil {
		t.Fatal(err)
	}
	kind := "user"
	authorKind := "human"
	if input.AuthorKind == "bot" {
		kind = "bot"
		authorKind = "bot"
	}
	if _, err := fixture.pool.Exec(fixture.ctx, `
		INSERT INTO messages (
		  id, space_id, conversation_id, author_id, author_kind, kind, client_message_id,
		  content_format, content_json, plain_text, created_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
	`, input.MessageID, DefaultSpaceID, input.ConversationID, input.AuthorID, authorKind, kind,
		input.MessageID, MessageContentFormat, string(content), input.Text, input.CreatedAt); err != nil {
		t.Fatal(err)
	}
	eventPayload, err := json.Marshal(map[string]any{
		"messageId": input.MessageID, "conversationId": input.ConversationID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.pool.Exec(fixture.ctx, `
		INSERT INTO workspace_events (
		  id, space_id, seq, type, actor_user_id, conversation_id, target_type, target_id,
		  payload_json, created_at
		) VALUES ($1, $2, $3, 'message.created', $4, $5, 'message', $6, $7, $8)
	`, input.EventID, DefaultSpaceID, input.Sequence, input.AuthorID, input.ConversationID,
		input.MessageID, string(eventPayload), input.CreatedAt); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.pool.Exec(fixture.ctx, `
		UPDATE workspace_event_cursors SET next_seq = GREATEST(next_seq, $1) WHERE space_id = $2
	`, input.Sequence+1, DefaultSpaceID); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.pool.Exec(fixture.ctx, `
		INSERT INTO workspace_agent_bot_deliveries
		  (id, bot_id, space_id, sequence, event_id, event_type, conversation_id,
		   payload_json, status, created_at, expires_at)
		VALUES ($1, $2, $3, $4, $5, 'message.created', $6, '{}', 'queued', $7, $8)
	`, input.DeliveryID, input.BotID, DefaultSpaceID, input.Sequence, input.EventID,
		input.ConversationID, input.CreatedAt, fixture.now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
}

type agentPlatformEventInput struct {
	BotID          string
	ConversationID string
	AuthorID       string
	AuthorKind     string
	MessageID      string
	EventID        string
	DeliveryID     string
	Sequence       int64
	Text           string
	CreatedAt      time.Time
	Blocks         []map[string]any
}

func agentPlatformTask(result map[string]any) *AgentTask {
	task, _ := result["task"].(*AgentTask)
	return task
}

func agentPlatformRequireCode(t *testing.T, err error, code string) {
	t.Helper()
	if !isCode(err, code) {
		t.Fatalf("error code = %v, want %s", err, code)
	}
}

func TestPGBotAgentTaskRequiresDeliveredEventAndBindsIdentity(t *testing.T) {
	fixture := openAgentPlatformPGFixture(t)
	if _, err := fixture.service.CreateAgentTask(fixture.ctx, fixture.auth, "event-botgateway"); err == nil {
		t.Fatal("undelivered event unexpectedly created a task")
	} else {
		agentPlatformRequireCode(t, err, "task.authorization_required")
	}

	agentPlatformQueueSeedEvent(t, fixture)
	created, err := fixture.service.CreateAgentTask(fixture.ctx, fixture.auth, "event-botgateway")
	if err != nil {
		t.Fatal(err)
	}
	task := agentPlatformTask(created)
	if task == nil {
		t.Fatalf("task projection = %#v", created)
	}
	if task.BotID != fixture.auth.BotID || task.TokenID != fixture.auth.TokenID || task.SpaceID != fixture.auth.SpaceID || task.ConversationID != "conversation-botgateway" {
		t.Fatalf("task binding = %#v", task)
	}
	if task.EventID != "event-botgateway" || task.TriggerMessageID != "message-botgateway" || task.RootTaskID != task.ID {
		t.Fatalf("task trigger binding = %#v", task)
	}
	if task.AuthorizationHash == "" {
		t.Fatal("task authorization hash was not persisted")
	}
	if _, err := fixture.service.GetAgentTask(fixture.ctx, fixture.auth, task.ID); err != nil {
		t.Fatal(err)
	}

	otherRaw := "dl_bot_cccccccccccccccccccccccccccccccccccccccc"
	otherScopes, err := json.Marshal([]string{ScopeMessagesReadTrigger, ScopeMessagesReadContext})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.pool.Exec(fixture.ctx, `
		INSERT INTO workspace_agent_bot_tokens (id, bot_id, space_id, token_hash, scopes_json, created_at)
		VALUES ('token-agent-platform-other', 'bot-botgateway', $1, $2, $3, $4)
	`, DefaultSpaceID, HashToken(otherRaw), string(otherScopes), fixture.now); err != nil {
		t.Fatal(err)
	}
	otherAuth, err := fixture.service.Authenticate(fixture.ctx, "Bearer "+otherRaw, TokenAuthOptions{SpaceID: DefaultSpaceID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.GetAgentTask(fixture.ctx, otherAuth, task.ID); err == nil {
		t.Fatal("task was readable through a different Token")
	} else {
		agentPlatformRequireCode(t, err, "task.authorization_required")
	}

	wrongConversation := WithAgentTaskID(fixture.ctx, task.ID)
	if _, err := fixture.service.ListAgentHistory(wrongConversation, fixture.auth, "conversation-does-not-match", nil); err == nil {
		t.Fatal("task was usable for another conversation")
	} else {
		agentPlatformRequireCode(t, err, "task.authorization_required")
	}
}

func TestPGBotAgentEmptyAuthorizationHashCannotBeValidated(t *testing.T) {
	fixture := openAgentPlatformPGFixture(t)
	trigger, err := fixture.service.repo.GetMessageTrigger(fixture.ctx, DefaultSpaceID, "conversation-botgateway", "message-botgateway")
	if err != nil {
		t.Fatal(err)
	}
	if trigger == nil {
		t.Fatal("seed trigger is missing")
	}
	store, ok := fixture.service.repo.(AgentTaskStore)
	if !ok {
		t.Fatal("gateway repository is not an AgentTaskStore")
	}
	// This deliberately models a hand-built task with no compatibility hash.
	// The formal CreateAgentTask path computes the hash; an empty value must not
	// become a usable authorization when a fixture or old caller bypasses it.
	task := AgentTask{
		ID:                "task-agent-platform-empty-hash",
		BotID:             fixture.auth.BotID,
		TokenID:           fixture.auth.TokenID,
		SpaceID:           fixture.auth.SpaceID,
		ConversationID:    "conversation-botgateway",
		EventID:           "event-agent-platform-empty-hash",
		TriggerMessageID:  "message-botgateway",
		RequestorUserID:   trigger.AuthorID,
		RootTaskID:        "task-agent-platform-empty-hash",
		InputHash:         messageInputHash(trigger),
		AuthorizationHash: "",
		CreatedAt:         fixture.now,
		ExpiresAt:         fixture.now.Add(AgentTaskLifetime),
	}
	if _, err := store.CreateAgentTask(fixture.ctx, task); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.GetAgentTask(fixture.ctx, fixture.auth, task.ID); err == nil {
		t.Fatal("task with an empty authorization hash was accepted")
	} else {
		agentPlatformRequireCode(t, err, "task.invalidated")
	}
}

func TestPGBotAgentTriggerReadDoesNotGrantHistory(t *testing.T) {
	t.Run("trigger-only", func(t *testing.T) {
		fixture := openAgentPlatformPGFixture(t)
		agentPlatformSetTokenScopes(t, fixture, fixture.auth.TokenID, []string{ScopeMessagesReadTrigger})
		agentPlatformQueueSeedEvent(t, fixture)
		created, err := fixture.service.CreateAgentTask(fixture.ctx, fixture.auth, "event-botgateway")
		if err != nil {
			t.Fatal(err)
		}
		task := agentPlatformTask(created)
		if task == nil {
			t.Fatal("missing task")
		}
		taskContext := WithAgentTaskID(fixture.ctx, task.ID)
		if _, err := fixture.service.GetAgentMessage(taskContext, fixture.auth, task.TriggerMessageID); err != nil {
			t.Fatalf("exact trigger read = %v", err)
		}
		if _, err := fixture.service.ListAgentHistory(taskContext, fixture.auth, task.ConversationID, nil); err == nil {
			t.Fatal("trigger scope unexpectedly granted history")
		} else {
			agentPlatformRequireCode(t, err, CodeScopeDenied)
		}
	})

	t.Run("context-grant", func(t *testing.T) {
		fixture := openAgentPlatformPGFixture(t)
		agentPlatformSetTokenScopes(t, fixture, fixture.auth.TokenID, []string{ScopeMessagesReadTrigger, ScopeMessagesReadContext})
		agentPlatformQueueSeedEvent(t, fixture)
		created, err := fixture.service.CreateAgentTask(fixture.ctx, fixture.auth, "event-botgateway")
		if err != nil {
			t.Fatal(err)
		}
		task := agentPlatformTask(created)
		if task == nil {
			t.Fatal("missing task")
		}
		taskContext := WithAgentTaskID(fixture.ctx, task.ID)
		result, err := fixture.service.ListAgentHistory(taskContext, fixture.auth, task.ConversationID, map[string]any{"limit": 1})
		if err != nil {
			t.Fatalf("history with context grant = %v", err)
		}
		if messages, ok := result["messages"].([]ContextMessage); !ok || len(messages) != 1 {
			t.Fatalf("history result = %#v", result)
		}
		if _, err := fixture.pool.Exec(fixture.ctx, `
			UPDATE workspace_agent_bot_context_grants SET allow_context = 0 WHERE bot_id = $1 AND conversation_id = $2
		`, fixture.auth.BotID, task.ConversationID); err != nil {
			t.Fatal(err)
		}
		if _, err := fixture.service.ListAgentHistory(taskContext, fixture.auth, task.ConversationID, nil); err == nil {
			t.Fatal("history remained readable after context grant revocation")
		} else {
			agentPlatformRequireCode(t, err, "task.invalidated")
		}
	})
}

func TestPGBotAgentTaskInvalidatesWhenTriggerChanges(t *testing.T) {
	for _, testCase := range []string{"edit", "recall"} {
		t.Run(testCase, func(t *testing.T) {
			fixture := openAgentPlatformPGFixture(t)
			agentPlatformQueueSeedEvent(t, fixture)
			created, err := fixture.service.CreateAgentTask(fixture.ctx, fixture.auth, "event-botgateway")
			if err != nil {
				t.Fatal(err)
			}
			task := agentPlatformTask(created)
			if task == nil {
				t.Fatal("missing task")
			}
			if testCase == "edit" {
				content := `{"format":"duallane.message+json;v=1","plainText":"修改后的请求","blocks":[{"type":"text","text":"修改后的请求"}]}`
				if _, err := fixture.pool.Exec(fixture.ctx, `
					UPDATE messages SET content_json = $1, plain_text = '修改后的请求'
					WHERE id = $2
				`, content, task.TriggerMessageID); err != nil {
					t.Fatal(err)
				}
			} else if _, err := fixture.pool.Exec(fixture.ctx, `
				UPDATE messages SET recalled_at = $1 WHERE id = $2
			`, fixture.now, task.TriggerMessageID); err != nil {
				t.Fatal(err)
			}
			if _, err := fixture.service.GetAgentMessage(WithAgentTaskID(fixture.ctx, task.ID), fixture.auth, task.TriggerMessageID); err == nil {
				t.Fatal("changed trigger remained authorized")
			} else {
				agentPlatformRequireCode(t, err, "task.invalidated")
			}
		})
	}
}

func TestPGBotAgentAuthorizationHashInvalidatesOnCapabilityTightening(t *testing.T) {
	for _, testCase := range []string{"token scope", "settings"} {
		t.Run(testCase, func(t *testing.T) {
			fixture := openAgentPlatformPGFixture(t)
			agentPlatformSetTokenScopes(t, fixture, fixture.auth.TokenID, []string{ScopeMessagesReadTrigger, ScopeMessagesReadContext})
			agentPlatformQueueSeedEvent(t, fixture)
			created, err := fixture.service.CreateAgentTask(fixture.ctx, fixture.auth, "event-botgateway")
			if err != nil {
				t.Fatal(err)
			}
			task := agentPlatformTask(created)
			if task == nil {
				t.Fatal("missing task")
			}
			if task.AuthorizationHash == "" {
				t.Fatal("task authorization hash was empty")
			}
			if testCase == "token scope" {
				agentPlatformSetTokenScopes(t, fixture, fixture.auth.TokenID, []string{ScopeMessagesReadTrigger})
			} else if _, err := fixture.pool.Exec(fixture.ctx, `
				UPDATE workspace_agent_bot_settings SET allow_direct = 0 WHERE bot_id = $1 AND space_id = $2
			`, fixture.auth.BotID, DefaultSpaceID); err != nil {
				t.Fatal(err)
			}
			if _, err := fixture.service.GetAgentMessage(WithAgentTaskID(fixture.ctx, task.ID), fixture.auth, task.TriggerMessageID); err == nil {
				t.Fatal("task survived a tightened authorization input")
			} else {
				agentPlatformRequireCode(t, err, "task.invalidated")
			}
		})
	}
}

func TestPGBotAgentGroupRemovalRevokesTaskReadAndPublish(t *testing.T) {
	fixture := openAgentPlatformPGFixture(t)
	agentPlatformSetPolicy(t, fixture, fixture.auth.BotID, agentPlatformPolicy(false), true)
	agentPlatformSetTokenScopes(t, fixture, fixture.auth.TokenID, []string{ScopeMessagesReadTrigger, ScopeMessagesReadContext, ScopeMessagesSend})
	agentPlatformInsertConversation(t, fixture, "conversation-agent-platform-group", "group", "user-owner-botgateway", "user-botgateway")
	agentPlatformAuthorizeGroup(t, fixture, fixture.auth.BotID, "conversation-agent-platform-group")
	agentPlatformInsertMessageEventDelivery(t, fixture, agentPlatformEventInput{
		BotID: fixture.auth.BotID, ConversationID: "conversation-agent-platform-group", AuthorID: "user-owner-botgateway",
		MessageID: "message-agent-platform-group", EventID: "event-agent-platform-group", DeliveryID: "delivery-agent-platform-group",
		Sequence: 10, Text: "群内请求", CreatedAt: fixture.now.Add(-time.Minute),
		Blocks: []map[string]any{{"type": "mention", "userId": "user-botgateway"}, {"type": "text", "text": "群内请求"}},
	})
	created, err := fixture.service.CreateAgentTask(fixture.ctx, fixture.auth, "event-agent-platform-group")
	if err != nil {
		t.Fatal(err)
	}
	task := agentPlatformTask(created)
	if task == nil {
		t.Fatal("missing task")
	}
	if _, err := fixture.pool.Exec(fixture.ctx, `
		UPDATE conversation_members SET removed_at = $1
		WHERE conversation_id = $2 AND user_id = $3
	`, fixture.now, task.ConversationID, fixture.auth.UserID); err != nil {
		t.Fatal(err)
	}
	taskContext := WithAgentTaskID(fixture.ctx, task.ID)
	if _, err := fixture.service.GetAgentMessage(taskContext, fixture.auth, task.TriggerMessageID); err == nil {
		t.Fatal("removed group Bot still read through the task")
	} else {
		agentPlatformRequireCode(t, err, "task.invalidated")
	}
	if _, err := fixture.service.SendMessage(taskContext, fixture.auth, SendMessageInput{
		ConversationID: task.ConversationID, ClientMessageID: "message-agent-platform-after-removal",
		IdempotencyKey: "idem-agent-platform-after-removal", Text: "不应发布",
	}); err == nil {
		t.Fatal("removed group Bot still published through the task")
	} else {
		agentPlatformRequireCode(t, err, "task.invalidated")
	}
}

func TestPGBotAgentHistoryCursorCannotCrossTaskOrConversation(t *testing.T) {
	fixture := openAgentPlatformPGFixture(t)
	agentPlatformInsertConversation(t, fixture, "conversation-agent-platform-history", "direct", "user-owner-botgateway", "user-botgateway")
	if _, err := fixture.pool.Exec(fixture.ctx, `
		INSERT INTO workspace_agent_bot_context_grants
		  (grant_id, bot_id, space_id, conversation_id, allow_trigger, allow_context, max_messages, granted_by, created_at, updated_at)
		VALUES ('grant-agent-platform-history', $1, $2, $3, 1, 1, 50, 'user-owner-botgateway', $4, $4)
	`, fixture.auth.BotID, DefaultSpaceID, "conversation-agent-platform-history", fixture.now); err != nil {
		t.Fatal(err)
	}
	for _, input := range []agentPlatformEventInput{
		{BotID: fixture.auth.BotID, ConversationID: "conversation-agent-platform-history", AuthorID: "user-owner-botgateway", MessageID: "message-agent-platform-history-1", EventID: "event-agent-platform-history-1", DeliveryID: "delivery-agent-platform-history-1", Sequence: 20, Text: "历史一", CreatedAt: fixture.now.Add(-3 * time.Minute)},
		{BotID: fixture.auth.BotID, ConversationID: "conversation-agent-platform-history", AuthorID: "user-owner-botgateway", MessageID: "message-agent-platform-history-2", EventID: "event-agent-platform-history-2", DeliveryID: "delivery-agent-platform-history-2", Sequence: 21, Text: "历史二", CreatedAt: fixture.now.Add(-2 * time.Minute)},
	} {
		agentPlatformInsertMessageEventDelivery(t, fixture, input)
	}
	firstResult, err := fixture.service.CreateAgentTask(fixture.ctx, fixture.auth, "event-agent-platform-history-1")
	if err != nil {
		t.Fatal(err)
	}
	firstTask := agentPlatformTask(firstResult)
	if firstTask == nil {
		t.Fatal("missing first task")
	}
	secondResult, err := fixture.service.CreateAgentTask(fixture.ctx, fixture.auth, "event-agent-platform-history-2")
	if err != nil {
		t.Fatal(err)
	}
	secondTask := agentPlatformTask(secondResult)
	if secondTask == nil {
		t.Fatal("missing second task")
	}
	firstContext := WithAgentTaskID(fixture.ctx, firstTask.ID)
	page, err := fixture.service.ListAgentHistory(firstContext, fixture.auth, firstTask.ConversationID, map[string]any{"limit": 1})
	if err != nil {
		t.Fatal(err)
	}
	cursor, ok := page["nextCursor"].(string)
	if !ok || cursor == "" {
		t.Fatalf("first history page did not return a cursor: %#v", page)
	}
	secondContext := WithAgentTaskID(fixture.ctx, secondTask.ID)
	if _, err := fixture.service.ListAgentHistory(secondContext, fixture.auth, secondTask.ConversationID, map[string]any{"before": cursor}); err == nil {
		t.Fatal("history cursor was accepted by another task")
	} else {
		agentPlatformRequireCode(t, err, CodeInvalidRequest)
	}
	if _, err := fixture.service.ListAgentHistory(firstContext, fixture.auth, "conversation-botgateway", map[string]any{"before": cursor}); err == nil {
		t.Fatal("history cursor was accepted by another conversation")
	} else {
		agentPlatformRequireCode(t, err, "task.authorization_required")
	}
}

func TestPGBotAgentDuplicateCreationSharesRootBudgetAcrossConcurrency(t *testing.T) {
	fixture := openAgentPlatformPGFixture(t)
	agentPlatformQueueSeedEvent(t, fixture)
	firstResult, err := fixture.service.CreateAgentTask(fixture.ctx, fixture.auth, "event-botgateway")
	if err != nil {
		t.Fatal(err)
	}
	firstTask := agentPlatformTask(firstResult)
	if firstTask == nil {
		t.Fatal("missing task")
	}
	taskContext := WithAgentTaskID(fixture.ctx, firstTask.ID)
	if err := fixture.service.consumeAgentRead(taskContext, fixture.auth, firstTask.ConversationID, 1); err != nil {
		t.Fatal(err)
	}
	results := make(chan *AgentTask, 8)
	errorsCh := make(chan error, 8)
	var wait sync.WaitGroup
	for i := 0; i < 8; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			result, createErr := fixture.service.CreateAgentTask(fixture.ctx, fixture.auth, "event-botgateway")
			if createErr != nil {
				errorsCh <- createErr
				return
			}
			results <- agentPlatformTask(result)
		}()
	}
	wait.Wait()
	close(results)
	close(errorsCh)
	for err := range errorsCh {
		t.Fatal(err)
	}
	for task := range results {
		if task == nil || task.ID != firstTask.ID {
			t.Fatalf("duplicate create returned task %#v instead of %s", task, firstTask.ID)
		}
	}
	var taskCount, readsUsed int
	if err := fixture.pool.QueryRow(fixture.ctx, `
		SELECT COUNT(*), COALESCE(MAX(reads_used), 0) FROM workspace_agent_tasks
		WHERE bot_id = $1 AND event_id = $2
	`, fixture.auth.BotID, firstTask.EventID).Scan(&taskCount, &readsUsed); err != nil {
		t.Fatal(err)
	}
	if taskCount != 1 || readsUsed != 1 {
		t.Fatalf("duplicate task rows/budget = %d/%d, want 1/1", taskCount, readsUsed)
	}

	readResults := make(chan error, AgentTaskMaxReads+8)
	for i := 0; i < AgentTaskMaxReads+8; i++ {
		go func() {
			readResults <- fixture.service.consumeAgentRead(taskContext, fixture.auth, firstTask.ConversationID, 1)
		}()
	}
	successes := 0
	budgetFailures := 0
	for i := 0; i < AgentTaskMaxReads+8; i++ {
		err := <-readResults
		switch {
		case err == nil:
			successes++
		case isCode(err, "task.budget_exceeded"):
			budgetFailures++
		default:
			t.Fatalf("concurrent read error = %v", err)
		}
	}
	if successes != AgentTaskMaxReads-1 || budgetFailures != 9 {
		t.Fatalf("budget outcomes = success:%d budget:%d, want success:%d budget:9", successes, budgetFailures, AgentTaskMaxReads-1)
	}
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT reads_used FROM workspace_agent_tasks WHERE id = $1`, firstTask.ID).Scan(&readsUsed); err != nil {
		t.Fatal(err)
	}
	if readsUsed != AgentTaskMaxReads {
		t.Fatalf("root task reads_used = %d, want %d", readsUsed, AgentTaskMaxReads)
	}
}

func TestPGBotAgentSourceRequiresAllowlistAndAuthorizedHumanRoot(t *testing.T) {
	fixture := openAgentPlatformPGFixture(t)
	const (
		otherBotID   = "bot-agent-platform-source"
		otherBotUser = "user-agent-platform-source"
		groupID      = "conversation-agent-platform-bots"
	)
	if _, err := fixture.pool.Exec(fixture.ctx, `
		INSERT INTO users (id, github_id, github_login, email, display_name, nickname, kind, created_at, last_login_at)
		VALUES ($1, NULL, 'agent-platform-source', NULL, 'Source Bot', 'Source Bot', 'bot', $2, NULL)
	`, otherBotUser, fixture.now); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.pool.Exec(fixture.ctx, `
		INSERT INTO space_members (space_id, user_id, role, joined_at)
		VALUES ($1, $2, 'member', $3)
	`, DefaultSpaceID, otherBotUser, fixture.now); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.pool.Exec(fixture.ctx, `
		INSERT INTO workspace_agent_bots
		  (id, space_id, owner_user_id, bot_user_id, name, name_normalized,
		   visibility_policy, conversation_policy, trigger_policy, status, created_at, updated_at)
		VALUES ($1, $2, 'user-owner-botgateway', $3, 'Source Bot', 'source bot',
		        'private', 'group-capable', 'mention-or-command', 'active', $4, $4)
	`, otherBotID, DefaultSpaceID, otherBotUser, fixture.now); err != nil {
		t.Fatal(err)
	}
	otherRaw := "dl_bot_dddddddddddddddddddddddddddddddddddddddd"
	otherScopes := `["messages:read_trigger","messages:read_context"]`
	if _, err := fixture.pool.Exec(fixture.ctx, `
		INSERT INTO workspace_agent_bot_tokens (id, bot_id, space_id, token_hash, scopes_json, created_at)
		VALUES ('token-agent-platform-source', $1, $2, $3, $4, $5)
	`, otherBotID, DefaultSpaceID, HashToken(otherRaw), otherScopes, fixture.now); err != nil {
		t.Fatal(err)
	}
	otherPolicy := agentPlatformPolicy(false)
	encodedOtherPolicy, err := json.Marshal(otherPolicy)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.pool.Exec(fixture.ctx, `
		INSERT INTO workspace_agent_bot_settings
		  (bot_id, space_id, allow_group, access_policy, created_at, updated_at)
		VALUES ($1, $2, 1, $3::jsonb, $4, $4)
	`, otherBotID, DefaultSpaceID, string(encodedOtherPolicy), fixture.now); err != nil {
		t.Fatal(err)
	}

	agentPlatformInsertConversation(t, fixture, groupID, "group", "user-owner-botgateway", "user-botgateway", otherBotUser)
	agentPlatformSetPolicy(t, fixture, fixture.auth.BotID, agentPlatformPolicy(false), true)
	agentPlatformAuthorizeGroup(t, fixture, fixture.auth.BotID, groupID)
	agentPlatformAuthorizeGroup(t, fixture, otherBotID, groupID)
	agentPlatformInsertMessageEventDelivery(t, fixture, agentPlatformEventInput{
		BotID: otherBotID, ConversationID: groupID, AuthorID: "user-owner-botgateway",
		MessageID: "message-agent-platform-human-root", EventID: "event-agent-platform-human-root", DeliveryID: "delivery-agent-platform-human-root",
		Sequence: 30, Text: "请由 Source Bot 处理", CreatedAt: fixture.now.Add(-2 * time.Minute),
		Blocks: []map[string]any{{"type": "mention", "userId": otherBotUser}, {"type": "text", "text": "请由 Source Bot 处理"}},
	})
	otherService := NewService(ServiceOptions{Repository: NewPGRepository(fixture.pool), SpaceID: DefaultSpaceID, Now: func() time.Time { return fixture.now }})
	otherAuth, err := otherService.Authenticate(fixture.ctx, "Bearer "+otherRaw, TokenAuthOptions{SpaceID: DefaultSpaceID})
	if err != nil {
		t.Fatal(err)
	}
	rootResult, err := otherService.CreateAgentTask(fixture.ctx, otherAuth, "event-agent-platform-human-root")
	if err != nil {
		t.Fatal(err)
	}
	rootTask := agentPlatformTask(rootResult)
	if rootTask == nil {
		t.Fatal("missing human-root task")
	}
	agentPlatformInsertMessageEventDelivery(t, fixture, agentPlatformEventInput{
		BotID: fixture.auth.BotID, ConversationID: groupID, AuthorID: otherBotUser, AuthorKind: "bot",
		MessageID: "message-agent-platform-source-reply", EventID: "event-agent-platform-source-reply", DeliveryID: "delivery-agent-platform-source-reply",
		Sequence: 31, Text: "Source Bot reply", CreatedAt: fixture.now.Add(-time.Minute),
		Blocks: []map[string]any{{"type": "mention", "userId": "user-botgateway"}, {"type": "text", "text": "Source Bot reply"}},
	})
	if _, err := fixture.pool.Exec(fixture.ctx, `
		INSERT INTO workspace_agent_message_origins (message_id, task_id)
		VALUES ('message-agent-platform-source-reply', $1)
	`, rootTask.ID); err != nil {
		t.Fatal(err)
	}

	if allowed, err := fixture.service.AuthorizeDelivery(fixture.ctx, fixture.auth, EventRecord{
		ID: "event-agent-platform-source-reply", SpaceID: DefaultSpaceID, EventType: "message.created",
		ActorUserID: otherBotUser, ConversationID: groupID, TargetType: "message", TargetID: "message-agent-platform-source-reply",
	}); err != nil {
		t.Fatal(err)
	} else if allowed {
		t.Fatal("Bot source was delivered while the target policy default was off")
	}

	approvedPolicy := agentPlatformPolicy(true, otherBotID)
	agentPlatformSetPolicy(t, fixture, fixture.auth.BotID, approvedPolicy, true)
	if allowed, err := fixture.service.AuthorizeDelivery(fixture.ctx, fixture.auth, EventRecord{
		ID: "event-agent-platform-source-reply", SpaceID: DefaultSpaceID, EventType: "message.created",
		ActorUserID: otherBotUser, ConversationID: groupID, TargetType: "message", TargetID: "message-agent-platform-source-reply",
	}); err != nil {
		t.Fatal(err)
	} else if !allowed {
		t.Fatal("explicitly allowlisted Bot source was not delivered")
	}

	if _, err := fixture.pool.Exec(fixture.ctx, `
		UPDATE conversation_members SET removed_at = $1
		WHERE conversation_id = $2 AND user_id = 'user-owner-botgateway'
	`, fixture.now, groupID); err != nil {
		t.Fatal(err)
	}
	if allowed, err := fixture.service.AuthorizeDelivery(fixture.ctx, fixture.auth, EventRecord{
		ID: "event-agent-platform-source-reply", SpaceID: DefaultSpaceID, EventType: "message.created",
		ActorUserID: otherBotUser, ConversationID: groupID, TargetType: "message", TargetID: "message-agent-platform-source-reply",
	}); err != nil {
		t.Fatal(err)
	} else if allowed {
		t.Fatal("Bot source retained access after its root human authorization was removed")
	}
}

type agentPlatformRevokeAfterMessageWriter struct {
	inner   MessageWriter
	pool    *pgxpool.Pool
	tokenID string
	at      time.Time
}

func (w *agentPlatformRevokeAfterMessageWriter) CreateBotMessage(ctx context.Context, input MessageWriteRequest) (GatewayMessage, error) {
	return w.inner.CreateBotMessage(ctx, input)
}

func (w *agentPlatformRevokeAfterMessageWriter) CreateBotMessageInTx(ctx context.Context, tx Tx, input MessageWriteRequest) (GatewayMessage, error) {
	writer, ok := w.inner.(TransactionalMessageWriter)
	if !ok {
		return GatewayMessage{}, errors.New("transactional message writer is required")
	}
	message, err := writer.CreateBotMessageInTx(ctx, tx, input)
	if err != nil {
		return GatewayMessage{}, err
	}
	transaction, ok := tx.(*pgTx)
	if !ok {
		return GatewayMessage{}, errors.New("PostgreSQL transaction required")
	}
	if _, err := transaction.tx.Exec(ctx, `
		UPDATE workspace_agent_bot_tokens SET revoked_at = $1 WHERE id = $2
	`, w.at, w.tokenID); err != nil {
		return GatewayMessage{}, err
	}
	return message, nil
}

func TestPGBotAgentMessageOriginRollsBackWithBoundTaskTransaction(t *testing.T) {
	fixture := openAgentPlatformPGFixture(t)
	agentPlatformSetTokenScopes(t, fixture, fixture.auth.TokenID, []string{ScopeMessagesReadTrigger, ScopeMessagesSend})
	agentPlatformQueueSeedEvent(t, fixture)
	created, err := fixture.service.CreateAgentTask(fixture.ctx, fixture.auth, "event-botgateway")
	if err != nil {
		t.Fatal(err)
	}
	task := agentPlatformTask(created)
	if task == nil {
		t.Fatal("missing task")
	}
	messageRepository := workspacemessages.NewPGRepository(fixture.pool)
	messageService := workspacemessages.NewService(workspacemessages.ServiceOptions{
		Repository: messageRepository,
		SpaceID:    DefaultSpaceID,
		Now:        func() time.Time { return fixture.now },
		AllowBots:  true,
	})
	adapters := NewRuntimeAdapters(RuntimeAdapterOptions{Messages: messageService})
	revokingWriter := &agentPlatformRevokeAfterMessageWriter{
		inner: adapters.MessageWriter, pool: fixture.pool, tokenID: fixture.auth.TokenID, at: fixture.now.Add(time.Second),
	}
	gatewayRepository := NewPGRepositoryWithDomainTransactions(fixture.pool, DomainTransactionOptions{Messages: messageRepository})
	transactionalService := NewService(ServiceOptions{
		Repository:    gatewayRepository,
		MessageWriter: revokingWriter,
		SpaceID:       DefaultSpaceID,
		Now:           func() time.Time { return fixture.now },
	})
	_, err = transactionalService.SendMessage(WithAgentTaskID(fixture.ctx, task.ID), fixture.auth, SendMessageInput{
		ConversationID:  task.ConversationID,
		ClientMessageID: "message-agent-platform-rollback",
		IdempotencyKey:  "idem-agent-platform-rollback",
		Text:            "应随事务回滚",
	})
	if err == nil {
		t.Fatal("revoked token unexpectedly committed a task-bound message")
	}
	if !isCode(err, CodeInvalidToken) && !isCode(err, "task.invalidated") {
		t.Fatalf("revocation error = %v", err)
	}
	var messageCount, originCount, idempotencyCount, writesUsed int
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT COUNT(*) FROM messages WHERE client_message_id = 'message-agent-platform-rollback'`).Scan(&messageCount); err != nil {
		t.Fatal(err)
	}
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT COUNT(*) FROM workspace_agent_message_origins WHERE task_id = $1`, task.ID).Scan(&originCount); err != nil {
		t.Fatal(err)
	}
	if err := fixture.pool.QueryRow(fixture.ctx, `
		SELECT COUNT(*) FROM workspace_agent_bot_idempotency
		WHERE bot_id = $1 AND operation = 'message.send' AND idempotency_key = 'idem-agent-platform-rollback'
	`, fixture.auth.BotID).Scan(&idempotencyCount); err != nil {
		t.Fatal(err)
	}
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT writes_used FROM workspace_agent_tasks WHERE id = $1`, task.ID).Scan(&writesUsed); err != nil {
		t.Fatal(err)
	}
	if messageCount != 0 || originCount != 0 || idempotencyCount != 0 || writesUsed != 0 {
		t.Fatalf("rollback rows = message:%d origin:%d idempotency:%d writes:%d", messageCount, originCount, idempotencyCount, writesUsed)
	}
}

func TestPGBotAgentMutationGuardOrdersConcurrentRevocation(t *testing.T) {
	fixture := openAgentPlatformPGFixture(t)
	agentPlatformQueueSeedEvent(t, fixture)
	created, err := fixture.service.CreateAgentTask(fixture.ctx, fixture.auth, "event-botgateway")
	if err != nil {
		t.Fatal(err)
	}
	task := agentPlatformTask(created)
	if task == nil {
		t.Fatal("missing task")
	}
	scoped := WithAgentTaskID(fixture.ctx, task.ID)
	entered := make(chan struct{})
	release := make(chan struct{})
	finished := make(chan error, 1)
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()
	go func() {
		finished <- fixture.service.repo.WithTx(scoped, func(tx Tx) error {
			store := tx.(AgentTaskMutation)
			if err := store.LockAgentAuthorization(scoped, task.ID, fixture.now); err != nil {
				return err
			}
			if err := store.ConsumeAgentTaskBudget(scoped, task.RootTaskID, 0, 0, 0, fixture.now); err != nil {
				return err
			}
			close(entered)
			select {
			case <-release:
			case <-time.After(10 * time.Second):
				return errors.New("guard test release timeout")
			}
			return fixture.service.validateAgentTask(scoped, tx, store, fixture.auth, task, task.ConversationID)
		})
	}()
	select {
	case <-entered:
	case err := <-finished:
		t.Fatalf("guard failed: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("guard did not acquire authorization locks")
	}
	for _, statement := range []struct {
		sql string
		id  string
	}{
		{`UPDATE workspace_agent_bot_tokens SET revoked_at=NOW() WHERE id=$1`, fixture.auth.TokenID},
		{`UPDATE messages SET plain_text='changed' WHERE id=$1`, task.TriggerMessageID},
		{`UPDATE workspace_agent_tasks SET cancelled_at=NOW() WHERE id=$1`, task.RootTaskID},
	} {
		external, err := fixture.pool.Begin(fixture.ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = external.Exec(fixture.ctx, `SET LOCAL lock_timeout='200ms'`); err != nil {
			external.Rollback(fixture.ctx)
			t.Fatal(err)
		}
		_, err = external.Exec(fixture.ctx, statement.sql, statement.id)
		_ = external.Rollback(fixture.ctx)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "55P03" {
			t.Fatalf("authorization change interposed before commit: %v", err)
		}
	}
	unblock()
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("guard did not complete")
	}
	if _, err := fixture.service.CancelAgentTask(fixture.ctx, fixture.auth, task.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.GetAgentMessage(scoped, fixture.auth, task.TriggerMessageID); err == nil {
		t.Fatal("task read survived cancellation after commit")
	}
}
