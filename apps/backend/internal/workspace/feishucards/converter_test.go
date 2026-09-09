package feishucards

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	workspacecards "github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
)

type corpus struct {
	Success        []successFixture        `json:"success"`
	Reconstruction []reconstructionFixture `json:"reconstruction"`
	Errors         []errorFixture          `json:"errors"`
}

type successFixture struct {
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
}

type reconstructionFixture struct {
	Name    string          `json:"name"`
	Payload json.RawMessage `json:"payload"`
}

type errorFixture struct {
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
	Code  string          `json:"code"`
}

type goldenFixture struct {
	Name         string `json:"name"`
	OK           bool   `json:"ok"`
	FallbackText string `json:"fallbackText"`
	PayloadJSON  string `json:"payloadJSON"`
	ErrorCode    string `json:"errorCode"`
}

var _ func(json.RawMessage) (json.RawMessage, error) = ValidatePayloadJSON

func TestNodeGoldenCorpus(t *testing.T) {
	cases := readCorpus(t)
	golden := readGolden(t)
	converter, err := NewConverter(Options{})
	if err != nil {
		t.Fatal(err)
	}
	for _, fixture := range cases.Success {
		fixture := fixture
		t.Run(fixture.Name, func(t *testing.T) {
			want := golden[fixture.Name]
			got, err := converter.ConvertJSON(fixture.Input)
			if err != nil {
				t.Fatalf("ConvertJSON() error = %v", err)
			}
			if string(got.PayloadJSON) != want.PayloadJSON {
				t.Fatalf("payload JSON differs from Node golden\n got: %s\nwant: %s", got.PayloadJSON, want.PayloadJSON)
			}
			if got.FallbackText != want.FallbackText {
				t.Fatalf("fallback = %q, want %q", got.FallbackText, want.FallbackText)
			}
			if !bytes.Equal(got.PayloadJSON, got.HashJSON) {
				t.Fatal("HashJSON must initially equal the ordered PayloadJSON")
			}
			got.PayloadJSON[0] = 'X'
			if bytes.Equal(got.PayloadJSON, got.HashJSON) {
				t.Fatal("HashJSON must be an independent copy")
			}
		})
	}
	for _, fixture := range cases.Reconstruction {
		fixture := fixture
		t.Run(fixture.Name, func(t *testing.T) {
			want := golden[fixture.Name]
			_, got, err := converter.ValidateConvertedJSON(fixture.Payload)
			if err != nil {
				t.Fatalf("ValidateConvertedJSON() error = %v", err)
			}
			if string(got) != want.PayloadJSON {
				t.Fatalf("validated payload JSON differs from Node golden\n got: %s\nwant: %s", got, want.PayloadJSON)
			}
		})
	}
	for _, fixture := range cases.Errors {
		fixture := fixture
		t.Run(fixture.Name, func(t *testing.T) {
			want := golden[fixture.Name]
			input := fixture.Input
			if bytes.Contains(input, []byte(`"__REPLACE_WITH_13K__"`)) {
				input = mustJSON(t, map[string]any{"elements": []any{map[string]any{"tag": "div", "text": map[string]any{"tag": "plain_text", "content": strings.Repeat("x", 13*1024)}}}})
			}
			if bytes.Contains(input, []byte(`"__REPLACE_WITH_81_HR__"`)) {
				elements := make([]any, 81)
				for index := range elements {
					elements[index] = map[string]any{"tag": "hr"}
				}
				input = mustJSON(t, map[string]any{"elements": elements})
			}
			var marker string
			if json.Unmarshal(input, &marker) == nil {
				switch marker {
				case "__REPLACE_WITH_13K__":
					input = mustJSON(t, map[string]any{"elements": []any{map[string]any{"tag": "div", "text": map[string]any{"tag": "plain_text", "content": strings.Repeat("x", 13*1024)}}}})
				case "__REPLACE_WITH_81_HR__":
					elements := make([]any, 81)
					for index := range elements {
						elements[index] = map[string]any{"tag": "hr"}
					}
					input = mustJSON(t, map[string]any{"elements": elements})
				}
			}
			_, err := converter.ConvertJSON(input)
			if err == nil {
				t.Fatalf("ConvertJSON() unexpectedly succeeded, want %s", fixture.Code)
			}
			if code := errorCode(err); code != fixture.Code {
				t.Fatalf("error code = %q, want %q", code, fixture.Code)
			}
			if want.ErrorCode != fixture.Code {
				t.Fatalf("Node golden error = %q, want %q", want.ErrorCode, fixture.Code)
			}
		})
	}
}

func TestOrderedPayloadUsesJavaScriptObjectKeyOrder(t *testing.T) {
	input := []byte(`{"elements":[{"tag":"action","actions":[{"tag":"button","text":"确认","value":{"action_id":"confirm","data":{"z":"last","0":"zero","a":"first"}}}]}]}`)
	result, err := ConvertJSON(input)
	if err != nil {
		t.Fatal(err)
	}
	const want = `"data":{"0":"zero","z":"last","a":"first"}`
	if !strings.Contains(string(result.PayloadJSON), want) {
		t.Fatalf("ordered data missing: %s", result.PayloadJSON)
	}
}

func TestValidatedRawPayloadPreservesDuplicateKeyOrderAndSurrogate(t *testing.T) {
	raw := []byte(`{"format":"duallane.feishu-card.v1","config":{"version":"1.0","wideScreen":false},"header":null,"elements":[{"type":"actions","buttons":[{"type":"button","label":"确认","actionId":"confirm","style":"default","data":{"z":"first","0":"zero","z":"last","a":"first","surrogate":"\ud800"}}]}]}`)
	_, canonical, err := ValidateConvertedJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	const want = `{"format":"duallane.feishu-card.v1","config":{"version":"1.0","wideScreen":false},"header":null,"elements":[{"type":"actions","buttons":[{"type":"button","label":"确认","actionId":"confirm","style":"default","data":{"0":"zero","z":"last","a":"first","surrogate":"\ud800"}}]}]}`
	if string(canonical) != want {
		t.Fatalf("canonical raw differs\n got: %s\nwant: %s", canonical, want)
	}
	validated, err := ValidatePayloadJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	if string(validated) != want {
		t.Fatalf("package raw validator differs\n got: %s\nwant: %s", validated, want)
	}
}

func TestRawJSONBudgetErrorsAreStableAndContentFree(t *testing.T) {
	over := bytes.Repeat([]byte("x"), rawJSONMaxBytes+1)
	_, err := ConvertJSON(over)
	if errorCode(err) != CodePayloadTooLarge || strings.Contains(err.Error(), "x") {
		t.Fatalf("oversize error = %v", err)
	}

	nested := []byte("null")
	for index := 0; index <= rawJSONMaxDepth; index++ {
		nested = append(append([]byte(`{"x":`), nested...), '}')
	}
	deep := append([]byte(`{"elements":[{"tag":"hr","deep":`), nested...)
	deep = append(deep, []byte(`}]}`)...)
	_, err = ConvertJSON(deep)
	if errorCode(err) != CodePayloadTooDeep || strings.Contains(err.Error(), "x") {
		t.Fatalf("deep error = %v", err)
	}
}

func TestDefinitionRegistersAllActionsAndCardsAdapter(t *testing.T) {
	definition := FeishuDefinition()
	if definition.CardType != CardType || definition.SchemaVersion != SchemaVersion || !definition.AllowPublicURLs {
		t.Fatalf("definition = %#v", definition)
	}
	for _, actionID := range ActionIDs {
		if action, ok := definition.Actions[actionID]; !ok || action.Execute == nil || action.ValidateInput == nil {
			t.Fatalf("missing action definition %q", actionID)
		}
	}
	cardDefinition := AsCardsDefinition()
	if cardDefinition.ValidatePayloadJSON == nil {
		t.Fatal("cards adapter did not register the Feishu raw validator")
	}
	registry, err := workspacecards.NewRegistry(cardDefinition)
	if err != nil {
		t.Fatal(err)
	}
	if registry.GetAction(CardType, SchemaVersion, "confirm") == nil {
		t.Fatal("registry did not normalize action lookup")
	}
	raw := json.RawMessage(`{"format":"duallane.feishu-card.v1","config":{"version":"1.0","wideScreen":false},"header":null,"elements":[{"type":"actions","buttons":[{"type":"button","label":"确认","actionId":"confirm","style":"default","data":{"z":"first","0":"zero","z":"last","a":"first","surrogate":"\ud800"}}]}]}`)
	validated, err := cardDefinition.ValidatePayloadJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	const wantCanonical = `{"format":"duallane.feishu-card.v1","config":{"version":"1.0","wideScreen":false},"header":null,"elements":[{"type":"actions","buttons":[{"type":"button","label":"确认","actionId":"confirm","style":"default","data":{"0":"zero","z":"last","a":"first","surrogate":"\ud800"}}]}]}`
	if string(validated) != wantCanonical {
		t.Fatalf("cards raw validator output = %s\nwant %s", validated, wantCanonical)
	}
	resolved, err := registry.ValidatePayloadJSON(workspacecards.CardBlock{
		Type: workspacecards.CardBlockType, CardID: "card-synthetic", CardType: CardType, SchemaVersion: SchemaVersion, FallbackText: "fallback",
	}, raw)
	if err != nil {
		t.Fatal(err)
	}
	registeredCanonical, ok := resolved.Payload.(json.RawMessage)
	if !ok || string(registeredCanonical) != wantCanonical {
		t.Fatalf("registered cards raw payload = %#v", resolved.Payload)
	}
}

func TestCardsAdapterPrefersPayloadJSONAndMarksActionEvent(t *testing.T) {
	converted, err := ConvertJSON([]byte(`{"elements":[{"tag":"action","actions":[{"tag":"button","text":"确认","value":{"action_id":"confirm","data":{"choice":"yes"}}}]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	action := mustCardsRegistryAction(t, "confirm")
	tx := &fakeCardsTx{Tx: nil, fakeActionTx: &fakeActionTx{bot: BotBinding{ID: "bot-synthetic", UserID: "bot-user-synthetic"}}}
	result, err := action.Execute(context.Background(), workspacecards.CardActionContext{
		Tx:             tx,
		Card:           workspacecards.Card{ID: "card-synthetic", SpaceID: "space-synthetic"},
		Payload:        map[string]any{"elements": []any{}},
		PayloadJSON:    json.RawMessage(converted.PayloadJSON),
		ClientActionID: "action-synthetic",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.ActionEventWritten {
		t.Fatal("successful Feishu action did not mark its event write")
	}
	if len(tx.events) != 1 || !bytes.Contains(tx.events[0].PayloadJSON, []byte(`"choice":"yes"`)) {
		t.Fatalf("adapter event = %#v", tx.events)
	}
}

func mustCardsRegistryAction(t *testing.T, actionID string) *workspacecards.CardAction {
	t.Helper()
	registry, err := workspacecards.NewRegistry(AsCardsDefinition())
	if err != nil {
		t.Fatal(err)
	}
	action := registry.GetAction(CardType, SchemaVersion, actionID)
	if action == nil {
		t.Fatalf("missing cards registry action %q", actionID)
	}
	return action
}

func TestActionBridgeUsesCallerTransactionAndPropagatesFailure(t *testing.T) {
	result, err := ConvertJSON([]byte(`{"elements":[{"tag":"action","actions":[{"tag":"button","text":"确认","value":{"action_id":"confirm","data":{"choice":"yes"}}}]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	tx := &fakeActionTx{bot: BotBinding{ID: "bot-synthetic", UserID: "bot-user-synthetic"}}
	action, ok := FeishuDefinition().Actions["confirm"]
	if !ok {
		t.Fatal("confirm action missing")
	}
	if _, err := action.ValidateInput(map[string]any{}); err != nil {
		t.Fatal(err)
	}
	acted, err := action.Execute(context.Background(), ActionContext{
		Tx: tx, ActorID: "actor-synthetic", Card: CardRef{ID: "card-synthetic", SpaceID: "space-synthetic", ConversationID: "conversation-synthetic"},
		Payload: result.PayloadJSON, Input: map[string]any{}, ClientActionID: "action-synthetic",
	})
	if err != nil || !reflect.DeepEqual(acted.Result, map[string]any{"accepted": true, "actionId": "confirm"}) {
		t.Fatalf("action result = %#v, err=%v", acted, err)
	}
	if tx.lookupCardID != "card-synthetic" || tx.lookupSpaceID != "space-synthetic" {
		t.Fatalf("active bot lookup = (%q, %q)", tx.lookupCardID, tx.lookupSpaceID)
	}
	wantEvent := CardActionEvent{
		SpaceID:        "space-synthetic",
		Type:           "card.action",
		ActorID:        "actor-synthetic",
		ConversationID: "conversation-synthetic",
		TargetType:     "workspace.card",
		TargetID:       "card-synthetic",
		PayloadJSON:    []byte(`{"botId":"bot-synthetic","botUserId":"bot-user-synthetic","cardId":"card-synthetic","actionId":"confirm","clientActionId":"action-synthetic","data":{"choice":"yes"}}`),
	}
	if len(tx.events) != 1 || !reflect.DeepEqual(tx.events[0], wantEvent) {
		t.Fatalf("event bridge = %#v", tx.events)
	}

	tx.writeErr = errors.New("synthetic transaction failure")
	if _, err := action.Execute(context.Background(), ActionContext{
		Tx: tx, ActorID: "actor-synthetic", Card: CardRef{ID: "card-synthetic", SpaceID: "space-synthetic"},
		Payload: result.PayloadJSON, Input: map[string]any{}, ClientActionID: "action-failing",
	}); err == nil {
		t.Fatal("failed transaction was swallowed")
	}
	if len(tx.events) != 1 {
		t.Fatal("failed event was recorded after the transaction rejected it")
	}
}

type fakeActionTx struct {
	bot           BotBinding
	lookupCardID  string
	lookupSpaceID string
	events        []CardActionEvent
	writeErr      error
}

type fakeCardsTx struct {
	workspacecards.Tx
	*fakeActionTx
}

func (tx *fakeActionTx) FindActiveBotForCard(_ context.Context, cardID, spaceID string) (BotBinding, bool, error) {
	tx.lookupCardID = cardID
	tx.lookupSpaceID = spaceID
	return tx.bot, true, nil
}

func (tx *fakeActionTx) WriteCardActionEvent(_ context.Context, event CardActionEvent) error {
	if tx.writeErr != nil {
		return tx.writeErr
	}
	tx.events = append(tx.events, event)
	return nil
}

func readCorpus(t *testing.T) corpus {
	t.Helper()
	var value corpus
	data, err := os.ReadFile(filepath.Join("testdata", "feishu-card-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func readGolden(t *testing.T) map[string]goldenFixture {
	t.Helper()
	var values []goldenFixture
	data, err := os.ReadFile(filepath.Join("testdata", "feishu-card-golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &values); err != nil {
		t.Fatal(err)
	}
	result := make(map[string]goldenFixture, len(values))
	for _, value := range values {
		result[value.Name] = value
	}
	return result
}

func marshalTestJSON(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func mustJSON(t *testing.T, value any) []byte {
	return marshalTestJSON(t, value)
}

func errorCode(err error) string {
	var validation *ValidationError
	if errors.As(err, &validation) {
		return validation.Code
	}
	return ""
}
