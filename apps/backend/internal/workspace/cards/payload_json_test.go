package cards

import (
	"encoding/json"
	"strings"
	"testing"
)

func rawPayloadBlock() CardBlock {
	return CardBlock{Type: CardBlockType, CardID: "card_raw", CardType: "test.raw", SchemaVersion: 1, FallbackText: "Raw card"}
}

func TestRawCanonicalPayloadIsValidatedAndCloned(t *testing.T) {
	raw := json.RawMessage(`{"z":"\ud800","a":{"second":2,"first":1}}`)
	var callbackInput json.RawMessage
	registry, err := NewRegistry(CardDefinition{CardType: "test.raw", SchemaVersion: 1,
		ValidatePayloadJSON: func(input json.RawMessage) (json.RawMessage, error) { callbackInput = input; return input, nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := registry.ValidatePayloadJSON(rawPayloadBlock(), raw)
	if err != nil {
		t.Fatal(err)
	}
	payload, ok := result.Payload.(json.RawMessage)
	if !ok || string(payload) != string(raw) {
		t.Fatalf("ordered canonical payload = %s", payload)
	}
	callbackInput[0] = 'X'
	if raw[0] != '{' || payload[0] != '{' {
		t.Fatal("canonical payload shares mutable callback input")
	}
}

func TestRawPayloadSafetyAppliesBeforeAndAfterCanonicalizer(t *testing.T) {
	for _, raw := range []json.RawMessage{
		json.RawMessage(`{"__proto__":{}}`),
		json.RawMessage(`{"text":"<script>alert(1)</script>"}`),
		json.RawMessage(`{"link":"http://127.0.0.1/private"}`),
		json.RawMessage(`{} {}`),
		json.RawMessage(strings.Repeat(" ", MaxPayloadBytes+1)),
	} {
		called := false
		registry, err := NewRegistry(CardDefinition{CardType: "test.raw", SchemaVersion: 1,
			ValidatePayloadJSON: func(input json.RawMessage) (json.RawMessage, error) { called = true; return input, nil },
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := registry.ValidatePayloadJSON(rawPayloadBlock(), raw); err == nil || called {
			t.Fatal("unsafe raw payload reached canonicalizer")
		}
		registry.Get("test.raw", 1).ValidatePayloadJSON = func(json.RawMessage) (json.RawMessage, error) { return raw, nil }
		if _, err := registry.ValidatePayloadJSON(rawPayloadBlock(), json.RawMessage(`{}`)); err == nil {
			t.Fatal("unsafe canonicalizer output was accepted")
		}
	}
}

func TestRawWithoutCanonicalizerUsesOrdinaryDomainValidation(t *testing.T) {
	registry, err := NewRegistry(CardDefinition{CardType: "test.raw", SchemaVersion: 1,
		ValidatePayload: func(any) (any, error) { return map[string]any{"safe": "only"}, nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := registry.ValidatePayloadJSON(rawPayloadBlock(), json.RawMessage(`{"ignored":"must not survive"}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := string(mustJSON(result.Payload)); got != `{"safe":"only"}` {
		t.Fatalf("unvalidated original survived: %s", got)
	}
}
