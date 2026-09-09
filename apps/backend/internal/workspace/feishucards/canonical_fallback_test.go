package feishucards

import (
	"encoding/json"
	"testing"
)

func TestCanonicalFallbackJSONPreservesValidatedUTF16Units(t *testing.T) {
	raw := json.RawMessage(`{"header":{"title":{"tag":"plain_text","content":"\ud800 title"}},"elements":[{"tag":"div","text":{"tag":"plain_text","content":"body"}}]}`)
	result, err := ConvertJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	if result.FallbackText != "\ufffd title" {
		t.Fatalf("persisted fallback = %q, want U+FFFD replacement", result.FallbackText)
	}
	if got, want := string(result.CanonicalFallbackJSON), `"\ud800 title"`; got != want {
		t.Fatalf("hash-only fallback JSON = %s, want %s", got, want)
	}
}
