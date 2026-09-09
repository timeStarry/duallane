package p2p

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestRealtimeSchemaDeclaresP2PFrameVariants(t *testing.T) {
	path := filepath.Join("..", "..", "api", "realtime", "p2p.schema.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var schema struct {
		AnyOf []json.RawMessage `json:"anyOf"`
		Defs  map[string]struct {
			UnevaluatedProperties *bool `json:"unevaluatedProperties"`
		} `json:"$defs"`
	}
	if err := json.Unmarshal(data, &schema); err != nil {
		t.Fatal(err)
	}
	if len(schema.AnyOf) != 4 {
		t.Fatalf("schema variants = %d, want 4", len(schema.AnyOf))
	}
	value, ok := schema.Defs["outboundSecure"]
	if !ok || value.UnevaluatedProperties == nil || *value.UnevaluatedProperties {
		t.Fatal("outboundSecure must explicitly reject unevaluated fields")
	}
}
