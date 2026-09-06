//go:build postgres_integration

package botgateway

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	workspacecards "github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	workspacemessages "github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

func TestPGGatewayReplaysNodePersistedHashesWithoutDomainSideEffects(t *testing.T) {
	ctx, pool := openBotGatewayAtomicityDatabase(t)
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	if _, err := pool.Exec(ctx, `UPDATE workspace_agent_bot_tokens SET scopes_json = $1 WHERE id = 'token-botgateway'`, `["messages:send","cards:write"]`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO conversations (id,space_id,type,title,direct_key,created_by,created_at)
		VALUES ('conv_hash',$1,'direct','Synthetic hashes','hash-direct','user-owner-botgateway',$2)`, DefaultSpaceID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO conversation_members (conversation_id,user_id,joined_at)
		VALUES ('conv_hash','user-botgateway',$1),('conv_hash','user-owner-botgateway',$1)`, now); err != nil {
		t.Fatal(err)
	}
	messages := workspacemessages.NewPGRepository(pool)
	cards := workspacecards.NewPGRepository(pool)
	registry, err := workspacecards.NewRegistry()
	if err != nil {
		t.Fatal(err)
	}
	adapters := NewRuntimeAdapters(RuntimeAdapterOptions{
		Messages: workspacemessages.NewService(workspacemessages.ServiceOptions{Repository: messages, AllowBots: true, Now: func() time.Time { return now }}),
		Cards:    workspacecards.NewService(workspacecards.ServiceOptions{Repository: cards, Registry: registry, Now: func() time.Time { return now }}),
	})
	service := NewService(ServiceOptions{Repository: NewPGRepositoryWithDomainTransactions(pool, DomainTransactionOptions{Messages: messages, Cards: cards}),
		MessageWriter: adapters.MessageWriter, CardGateway: adapters.CardGateway, Now: func() time.Time { return now }})
	actor, err := service.Authenticate(ctx, "Bearer dl_bot_"+strings.Repeat("b", 40), TokenAuthOptions{SpaceID: DefaultSpaceID})
	if err != nil {
		t.Fatal(err)
	}
	counts := func() [4]int {
		var result [4]int
		if err := pool.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM messages),(SELECT COUNT(*) FROM workspace_cards),
			(SELECT COUNT(*) FROM workspace_events),(SELECT COUNT(*) FROM audit_logs)`).Scan(&result[0], &result[1], &result[2], &result[3]); err != nil {
			t.Fatal(err)
		}
		return result
	}
	for _, example := range readNodeIdempotencyFixtures(t).Operations {
		if example.Error != "" {
			continue
		}
		t.Run(example.Name, func(t *testing.T) {
			var fields map[string]json.RawMessage
			var values map[string]any
			if err := json.Unmarshal([]byte(example.Raw), &fields); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal([]byte(example.Raw), &values); err != nil {
				t.Fatal(err)
			}
			getString := func(key string) string { value, _ := values[key].(string); return value }
			operation := "message.send"
			response := `{"message":{"id":"node-existing","plainText":"Synthetic replay"},"clientMessageId":"` + getString("clientMessageId") + `"}`
			if example.Operation == "sendCard" {
				operation = "card.send"
				response = `{"card":{"id":"node-existing-card"},"message":{"id":"node-existing"}}`
			}
			if _, err := pool.Exec(ctx, `INSERT INTO workspace_agent_bot_idempotency
				(id,bot_id,token_id,space_id,operation,idempotency_key,request_hash,response_status,response_json,created_at,expires_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,200,$8,$9,$10)`, "node-"+example.Name, actor.BotID, actor.TokenID, actor.SpaceID, operation, getString("idempotencyKey"), example.Hash, response, now, now.Add(time.Hour)); err != nil {
				t.Fatal(err)
			}
			before := counts()
			if operation == "message.send" {
				input := SendMessageInput{ConversationID: getString("conversationId"), ClientMessageID: getString("clientMessageId"), IdempotencyKey: getString("idempotencyKey"), ReplyToMessageID: getString("replyToMessageId"), Fields: values, RawContent: fields["content"], RawText: fields["text"]}
				for index := 0; index < 2; index++ {
					result, err := service.SendMessage(ctx, actor, input)
					if err != nil || result.Message.ID != "node-existing" {
						t.Fatalf("Node replay failed: %v", err)
					}
				}
				input.RawContent = json.RawMessage(`"different synthetic text"`)
				if _, err := service.SendMessage(ctx, actor, input); !isCode(err, CodeIdempotencyConflict) {
					t.Fatalf("changed replay error = %v", err)
				}
			} else {
				input := SendCardInput{ConversationID: getString("conversationId"), ClientMessageID: getString("clientMessageId"), IdempotencyKey: getString("idempotencyKey"), CardType: values["cardType"], SchemaVersion: values["schemaVersion"], FallbackText: values["fallbackText"], Fields: values, RawPayload: fields["payload"]}
				for index := 0; index < 2; index++ {
					result, err := service.SendCard(ctx, actor, input)
					if err != nil || result.Card.ID != "node-existing-card" {
						t.Fatalf("Node card replay failed: %v", err)
					}
				}
				input.RawPayload = json.RawMessage(`{"changed":true}`)
				if _, err := service.SendCard(ctx, actor, input); !isCode(err, CodeIdempotencyConflict) {
					t.Fatalf("changed card replay error = %v", err)
				}
			}
			if counts() != before {
				t.Fatal("Node replay/conflict produced domain, audit or event writes")
			}
		})
	}
}
