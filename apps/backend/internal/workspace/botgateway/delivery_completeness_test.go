package botgateway

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestDeliveryTextCompletenessMarksUTF8Truncation(t *testing.T) {
	for _, tc := range []struct {
		name     string
		text     string
		complete bool
	}{
		{"short", "synthetic request", true},
		{"exact", strings.Repeat("a", MaxDeliveryTextBytes), true},
		{"truncated", strings.Repeat("a", MaxDeliveryTextBytes+1), false},
		{"multibyte", strings.Repeat("图", MaxDeliveryTextBytes/3+1), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payload, err := json.Marshal(map[string]any{"messageId": "message_1", "plainText": tc.text, "args": tc.text})
			if err != nil {
				t.Fatal(err)
			}
			result := parseObject(safeDeliveryPayload(EventRecord{EventType: "command.invoked", PayloadJSON: payload}))
			if result["textComplete"] != tc.complete || result["argsComplete"] != tc.complete {
				t.Fatalf("unexpected completeness text=%v args=%v", result["textComplete"], result["argsComplete"])
			}
			if len(stringField(result, "text")) > MaxDeliveryTextBytes {
				t.Fatal("text limit exceeded")
			}
		})
	}
}

func TestReplayProjectsCurrentTriggerWithoutHistoryGrant(t *testing.T) {
	for _, tc := range []struct {
		name     string
		payload  string
		text     string
		complete bool
	}{
		{"nested message producer", `{"messageId":"message_1","conversationId":"conv_direct","message":{"id":"message_1","plainText":"stale snapshot","content":{"blocks":[{"type":"attachment","attachmentId":"hidden_attachment"}]}}}`, "current request", true},
		{"IDs only producer", `{"messageId":"message_1","conversationId":"conv_direct"}`, "current request", true},
		{"inconsistent payload", `{"messageId":"other_message","conversationId":"other_conversation","plainText":"untrusted snapshot","args":"unrelated command","message":{"plainText":"other message"}}`, "current request", true},
		{"UTF8 truncated", `{"messageId":"message_1"}`, strings.Repeat("图", MaxDeliveryTextBytes/3+1), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo, service, authValue, _, _ := gatewayFixture(t)
			repo.auth.Scopes = []string{ScopeMessagesReadTrigger}
			repo.grants["conv_direct"] = &ContextGrant{AllowTrigger: true, AllowContext: false}
			repo.events = []EventRecord{{
				ID: "event_1", SpaceID: authValue.SpaceID, Sequence: 1, EventType: "message.created",
				ActorUserID: "owner_1", ConversationID: "conv_direct", TargetType: "message", TargetID: "message_1",
				PayloadJSON: []byte(tc.payload), CreatedAt: repo.now(),
			}}
			repo.triggers["conv_direct:message_1"] = &MessageTrigger{AuthorID: "owner_1", PlainText: tc.text,
				ContentJSON: []byte(`{"blocks":[{"type":"text","text":"request"}]}`)}
			result, err := service.Replay(context.Background(), authValue, ReplayInput{})
			if err != nil || len(result.Events) != 1 {
				t.Fatalf("replay result=%#v err=%v", result, err)
			}
			for _, payload := range []map[string]any{result.Events[0].Payload, parseObject(repo.deliveries[0].PayloadJSON)} {
				if len(payload) != 5 || payload["messageId"] != "message_1" || payload["conversationId"] != "conv_direct" || payload["actorUserId"] != "owner_1" {
					t.Fatalf("noncanonical trigger projection: %#v", payload)
				}
				text := stringField(payload, "text")
				if text != truncateUTF8Bytes(tc.text, MaxDeliveryTextBytes) || !utf8.ValidString(text) || len(text) > MaxDeliveryTextBytes || payload["textComplete"] != tc.complete {
					t.Fatalf("incorrect bounded trigger: %#v", payload)
				}
			}
			if _, err := service.GetContext(context.Background(), authValue, "conv_direct", nil); err == nil {
				t.Fatal("read-trigger delivery must not grant history")
			}
		})
	}
}

func TestReplayRefreshesQueuedTriggerAndRejectsRemovedMessage(t *testing.T) {
	for _, removal := range []string{"deleted", "recalled", "missing", "author changed", "membership removed"} {
		t.Run(removal, func(t *testing.T) {
			repo, service, authValue, _, _ := gatewayFixture(t)
			repo.auth.Scopes = []string{ScopeMessagesReadTrigger}
			repo.grants["conv_direct"].AllowContext = false
			now := repo.now()
			repo.events = []EventRecord{{ID: "event_1", SpaceID: authValue.SpaceID, Sequence: 1, EventType: "message.created",
				ActorUserID: "owner_1", ConversationID: "conv_direct", TargetType: "message", TargetID: "message_1",
				PayloadJSON: []byte(`{"messageId":"message_1"}`), CreatedAt: now}}
			message := &MessageTrigger{AuthorID: "owner_1", PlainText: "current request", ContentJSON: []byte(`{"blocks":[{"type":"text"}]}`)}
			repo.triggers["conv_direct:message_1"] = message
			repo.deliveries = []DeliveryRecord{{ID: "legacy_delivery", BotID: authValue.BotID, SpaceID: authValue.SpaceID,
				Sequence: 1, EventID: "event_1", EventType: "message.created", ConversationID: "conv_direct",
				PayloadJSON: []byte(`{"messageId":"message_1","text":"stale queued text"}`), Status: "queued",
				CreatedAt: now, ExpiresAt: now.Add(service.replayWindow)}}
			result, err := service.Replay(context.Background(), authValue, ReplayInput{})
			if err != nil || len(result.Events) != 1 || result.Events[0].Payload["text"] != "current request" || result.Events[0].Payload["textComplete"] != true {
				t.Fatalf("legacy queued delivery did not use current authority: %#v err=%v", result, err)
			}
			switch removal {
			case "deleted":
				message.DeletedAt = &now
			case "recalled":
				message.RecalledAt = &now
			case "missing":
				delete(repo.triggers, "conv_direct:message_1")
			case "author changed":
				message.AuthorID = "other_author"
			case "membership removed":
				repo.members["conv_direct:bot_user"] = false
			}
			result, err = service.Replay(context.Background(), authValue, ReplayInput{})
			if err != nil || len(result.Events) != 0 {
				t.Fatalf("removed trigger was delivered: %#v err=%v", result, err)
			}
		})
	}
}
