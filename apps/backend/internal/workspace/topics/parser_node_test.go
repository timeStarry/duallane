package topics

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestTopicParserMatchesActualNodeCorpus(t *testing.T) {
	raw, err := os.ReadFile("testdata/parser-node.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name     string
		Parts    []json.RawMessage
		Expected *struct{ Title, DescriptionSHA256 string }
	}
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	if len(fixtures) != 20 {
		t.Fatalf("corpus count=%d", len(fixtures))
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			var source strings.Builder
			for _, part := range fixture.Parts {
				var text string
				if json.Unmarshal(part, &text) == nil {
					source.WriteString(text)
					continue
				}
				var repeated []json.RawMessage
				var count int
				if json.Unmarshal(part, &repeated) != nil || len(repeated) != 2 || json.Unmarshal(repeated[0], &text) != nil || json.Unmarshal(repeated[1], &count) != nil || count < 0 || count > 30001 {
					t.Fatal("invalid corpus part")
				}
				source.WriteString(strings.Repeat(text, count))
			}
			intent, ok := ParseWorkspaceTopicSyntax(source.String())
			if ok != (fixture.Expected != nil) {
				t.Fatalf("valid=%v expected=%v", ok, fixture.Expected != nil)
			}
			if !ok {
				return
			}
			hash := sha256.Sum256([]byte(intent.Description))
			if intent.Title != fixture.Expected.Title || hex.EncodeToString(hash[:]) != fixture.Expected.DescriptionSHA256 {
				t.Fatal("Node/Go normalized intent differs")
			}
		})
	}
}
