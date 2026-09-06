package botgateway

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/feishucards"
)

type nodeFeishuFallbackHashFixture struct {
	Observations []struct {
		Input                  json.RawMessage `json:"input"`
		FallbackText           json.RawMessage `json:"fallbackText"`
		CreateStatus           int             `json:"createStatus"`
		HashInputJSON          string          `json:"hashInputJSON"`
		RequestHash            string          `json:"requestHash"`
		NormalizedFallbackHash string          `json:"normalizedFallbackHash"`
		HashDiffers            bool            `json:"hashDiffersWhenFallbackUsesDBValue"`
	} `json:"observations"`
}

func TestFeishuFallbackHashMatchesNodeRawUTF16Fixture(t *testing.T) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	fixturePath := filepath.Join(filepath.Dir(sourceFile), "testdata", "node-feishu-fallback.json")
	raw, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatal(err)
	}
	var fixture nodeFeishuFallbackHashFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, observation := range fixture.Observations {
		if observation.CreateStatus != 201 {
			_, err := normalizeGatewayCardCreate(SendCardInput{Format: "feishu-card", RawFeishuCard: observation.Input, RawFallbackText: observation.FallbackText})
			var publicErr *Error
			if !errors.As(err, &publicErr) || publicErr.StatusCode != observation.CreateStatus || publicErr.Code != CodeCardInvalidFallback {
				t.Fatalf("invalid fallback response=%v, want %d %s", err, observation.CreateStatus, CodeCardInvalidFallback)
			}
			continue
		}
		converted, err := feishucards.ConvertJSON(observation.Input)
		if err != nil {
			t.Fatal(err)
		}
		fallbackText := converted.FallbackText
		hashFallbackJSON := converted.CanonicalFallbackJSON
		if observation.FallbackText != nil {
			fallbackText, hashFallbackJSON, err = normalizeRawFallbackJSON(observation.FallbackText)
			if err != nil {
				t.Fatal(err)
			}
		}
		input := cardIdempotencyInput{
			ConversationID:   "conv_feishu_fallback",
			CardType:         converted.CardType,
			SchemaVersion:    converted.SchemaVersion,
			FallbackText:     fallbackText,
			Payload:          converted.Payload,
			RawPayload:       converted.PayloadJSON,
			HashFallbackJSON: hashFallbackJSON,
		}
		encoded, err := nodeJSONMarshal(input)
		if err != nil {
			t.Fatal(err)
		}
		if string(encoded) != observation.HashInputJSON {
			t.Fatalf("Node hash input differs\n got: %s\nwant: %s", encoded, observation.HashInputJSON)
		}
		got, err := hashGatewayRequest(input)
		if err != nil {
			t.Fatal(err)
		}
		if got != observation.RequestHash {
			t.Fatalf("Node request hash = %s, want %s", got, observation.RequestHash)
		}

		normalized := input
		normalized.HashFallbackJSON = nil
		normalizedHash, err := hashGatewayRequest(normalized)
		if err != nil {
			t.Fatal(err)
		}
		if normalizedHash != observation.NormalizedFallbackHash {
			t.Fatalf("normalized fallback hash = %s, want %s", normalizedHash, observation.NormalizedFallbackHash)
		}
		if (got != normalizedHash) != observation.HashDiffers {
			t.Fatalf("raw/normalized hash difference = %t, want %t", got != normalizedHash, observation.HashDiffers)
		}
	}
}

func TestSendCardFeishuFallbackPersistsReplacementAndReplaysNodeHash(t *testing.T) {
	repo, service, authValue, _, card := gatewayFixture(t)
	raw := json.RawMessage(`{"header":{"title":{"tag":"plain_text","content":"\ud800 title"}},"elements":[{"tag":"div","text":{"tag":"plain_text","content":"body"}}]}`)
	converted, err := feishucards.ConvertJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	input := SendCardInput{
		ConversationID: "conv_direct", ClientMessageID: "feishu-fallback-message", IdempotencyKey: "feishu-fallback-key",
		Format: "feishu-card", RawFeishuCard: raw,
		Fields: map[string]any{"format": "feishu-card", "feishuCard": map[string]any{}},
	}
	first, err := service.SendCard(context.Background(), authValue, input)
	if err != nil {
		t.Fatal(err)
	}
	if first.Card.FallbackText != "\ufffd title" || card.lastRequest.FallbackText != "\ufffd title" {
		t.Fatalf("persisted fallback = %q, request = %q", first.Card.FallbackText, card.lastRequest.FallbackText)
	}
	record, ok := repo.idempotency[authValue.BotID+":card.send:"+input.IdempotencyKey]
	if !ok {
		t.Fatal("Feishu fallback idempotency record missing")
	}
	wantHash, err := hashGatewayRequest(cardIdempotencyInput{
		ConversationID: "conv_direct", CardType: converted.CardType, SchemaVersion: converted.SchemaVersion,
		FallbackText: converted.FallbackText, Payload: converted.Payload, RawPayload: converted.PayloadJSON,
		HashFallbackJSON: converted.CanonicalFallbackJSON,
	})
	if err != nil {
		t.Fatal(err)
	}
	if record.RequestHash != wantHash {
		t.Fatalf("stored fallback hash = %s, want %s", record.RequestHash, wantHash)
	}
	if _, err := service.SendCard(context.Background(), authValue, input); err != nil {
		t.Fatal(err)
	}
	if card.count != 1 {
		t.Fatalf("Feishu fallback replay card writes = %d, want 1", card.count)
	}
}

func TestSendCardFeishuExplicitFallbackUsesValidatedRawUnits(t *testing.T) {
	repo, service, authValue, _, card := gatewayFixture(t)
	rawCard := json.RawMessage(`{"elements":[{"tag":"div","text":{"tag":"plain_text","content":"body"}}]}`)
	rawFallback := json.RawMessage(`"\ud800 explicit"`)
	input := SendCardInput{
		ConversationID: "conv_direct", ClientMessageID: "feishu-explicit-fallback-message", IdempotencyKey: "feishu-explicit-fallback-key",
		Format: "feishu-card", RawFeishuCard: rawCard, RawFallbackText: rawFallback,
		Fields: map[string]any{"format": "feishu-card", "feishuCard": map[string]any{}, "fallbackText": "\ufffd explicit"},
	}
	result, err := service.SendCard(context.Background(), authValue, input)
	if err != nil {
		t.Fatal(err)
	}
	if result.Card.FallbackText != "\ufffd explicit" || card.lastRequest.FallbackText != "\ufffd explicit" {
		t.Fatalf("explicit fallback persistence = %q/%q", result.Card.FallbackText, card.lastRequest.FallbackText)
	}
	_, hashFallback, err := normalizeRawFallbackJSON(rawFallback)
	if err != nil {
		t.Fatal(err)
	}
	record := repo.idempotency[authValue.BotID+":card.send:"+input.IdempotencyKey]
	wantHash, err := hashGatewayRequest(cardIdempotencyInput{
		ConversationID: "conv_direct", CardType: feishucards.CardType, SchemaVersion: feishucards.SchemaVersion,
		FallbackText: "\ufffd explicit", Payload: card.lastRequest.Payload, RawPayload: card.lastRequest.RawPayload,
		HashFallbackJSON: hashFallback,
	})
	if err != nil {
		t.Fatal(err)
	}
	if record.RequestHash != wantHash {
		t.Fatalf("explicit fallback hash = %s, want %s", record.RequestHash, wantHash)
	}
}
