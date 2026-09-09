package botgateway

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestGatewayPersistsNodeRequestHashesAndReplaysWithoutWrites(t *testing.T) {
	for _, example := range readNodeIdempotencyFixtures(t).Operations {
		t.Run(example.Name, func(t *testing.T) {
			repo, service, actor, writer, cards := gatewayFixture(t)
			repo.conversations["conv_hash"] = &Conversation{ID: "conv_hash", SpaceID: actor.SpaceID, Type: "direct"}
			repo.members["conv_hash:"+actor.UserID] = true
			var rawFields map[string]json.RawMessage
			var fields map[string]any
			if err := json.Unmarshal([]byte(example.Raw), &rawFields); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal([]byte(example.Raw), &fields); err != nil {
				t.Fatal(err)
			}
			fieldString := func(name string) string { value, _ := fields[name].(string); return value }
			operation := "message.send"
			call := func() error {
				if example.Operation == "sendMessage" {
					_, err := service.SendMessage(context.Background(), actor, SendMessageInput{
						ConversationID: fieldString("conversationId"), ClientMessageID: fieldString("clientMessageId"), IdempotencyKey: fieldString("idempotencyKey"),
						ReplyToMessageID: fieldString("replyToMessageId"), Content: fields["content"], Text: fieldString("text"),
						RawContent: rawFields["content"], RawText: rawFields["text"], Fields: fields,
					})
					return err
				}
				operation = "card.send"
				_, err := service.SendCard(context.Background(), actor, SendCardInput{
					ConversationID: fieldString("conversationId"), ClientMessageID: fieldString("clientMessageId"), IdempotencyKey: fieldString("idempotencyKey"),
					CardType: fields["cardType"], SchemaVersion: fields["schemaVersion"], FallbackText: fields["fallbackText"], Payload: fields["payload"],
					RawPayload: rawFields["payload"], Fields: fields,
				})
				return err
			}
			err := call()
			if example.Error != "" {
				if !isCode(err, example.Error) {
					t.Fatalf("error = %v, want %s", err, example.Error)
				}
				if len(repo.idempotency) != 0 || writer.count != 0 || cards.count != 0 {
					t.Fatal("rejected request wrote state")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			key := actor.BotID + ":" + operation + ":" + fieldString("idempotencyKey")
			if repo.idempotency[key].RequestHash != example.Hash {
				t.Fatal("persisted request hash differs from Node")
			}
			messageCount, cardCount := writer.count, cards.count
			if err := call(); err != nil {
				t.Fatal(err)
			}
			if writer.count != messageCount || cards.count != cardCount || len(repo.idempotency) != 1 {
				t.Fatal("replay duplicated side effects")
			}
		})
	}
}

type nodeIdempotencyFixtures struct {
	JSON []struct {
		Raw        string
		Normalized string
	}
	Operations []struct {
		Operation string
		Name      string
		Raw       string
		Hash      string
		Error     string
		Status    int
	}
}

func readNodeIdempotencyFixtures(t *testing.T) nodeIdempotencyFixtures {
	t.Helper()
	raw, err := os.ReadFile("testdata/node-idempotency.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures nodeIdempotencyFixtures
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	return fixtures
}

func TestNodeParsedJSONMatchesNode(t *testing.T) {
	for index, example := range readNodeIdempotencyFixtures(t).JSON {
		encoded, err := nodeParsedJSON([]byte(example.Raw))
		if err != nil || string(encoded) != example.Normalized {
			t.Fatalf("synthetic JSON case %d differs: %v", index, err)
		}
	}
}

func TestNodeParsedJSONRejectsInvalidAndOversizedValues(t *testing.T) {
	for _, raw := range []string{"", "null true", "{", "[1,]", string([]byte{'"', 0xff, '"'}), `"` + strings.Repeat("x", 1024*1024) + `"`, strings.Repeat("[", 10001) + strings.Repeat("]", 10001)} {
		if _, err := nodeParsedJSON([]byte(raw)); err == nil {
			t.Fatal("accepted invalid/oversized subtree")
		}
	}
}

func TestNodeParsedJSONRendersDeepInputWithoutRepeatedContainerCopies(t *testing.T) {
	const depth = 10000
	raw := strings.Repeat("[", depth) + `"synthetic"` + strings.Repeat("]", depth)
	encoded, err := nodeParsedJSON([]byte(raw))
	if err != nil || string(encoded) != raw {
		t.Fatal("bounded deep JSON failed")
	}
}

func FuzzNodeParsedJSON(f *testing.F) {
	for _, seed := range []string{`{"z":1,"a":2,"z":3}`, `["\ud800",-0,1e999]`, `{"10":1,"2":2}`, `{"z":[{},[],true,null,"\u2028"]}`} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, raw string) {
		encoded, err := nodeParsedJSON([]byte(raw))
		if err != nil {
			return
		}
		if !json.Valid(encoded) {
			t.Fatal("output is not JSON")
		}
		second, err := nodeParsedJSON(encoded)
		if err != nil || string(second) != string(encoded) {
			t.Fatal("JSON normalization is not idempotent")
		}
	})
}

func TestBotTextUsesNodeTrimAndUTF16Budget(t *testing.T) {
	if got, err := normalizeBotContent("\ufefftext\ufeff", ""); err != nil || got.PlainText != "text" {
		t.Fatal("BOM trim differs")
	}
	if got, err := normalizeBotContent("\u0085text\u0085", ""); err != nil || got.PlainText != "\u0085text\u0085" {
		t.Fatal("NEXT LINE trim differs")
	}
	if _, err := normalizeBotContent(strings.Repeat("😀", 15000), ""); err != nil {
		t.Fatal("rejected exact UTF-16 budget")
	}
	if _, err := normalizeBotContent(strings.Repeat("😀", 15001), ""); err == nil {
		t.Fatal("accepted UTF-16 overage")
	}
}

func TestGatewaySequenceRejectsIntegersOutsideNodeSafeRange(t *testing.T) {
	const maximum int64 = 1<<53 - 1
	for _, value := range []int64{-1, maximum + 1, 1<<63 - 1} {
		if _, err := normalizeSequence(value, true); !isCode(err, CodeInvalidSequence) {
			t.Fatalf("sequence %d error = %v", value, err)
		}
	}
	for _, value := range []int64{0, 1, maximum} {
		if got, err := normalizeSequence(value, true); err != nil || got != value {
			t.Fatalf("safe sequence %d rejected", value)
		}
	}
	if _, err := normalizeSequence(0, false); !isCode(err, CodeInvalidSequence) {
		t.Fatal("nonzero sequence contract lost")
	}
}
