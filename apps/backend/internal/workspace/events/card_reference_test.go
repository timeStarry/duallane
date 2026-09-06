package events

import "testing"

func TestSafeCardBlockKeepsOnlyReferenceAndPositiveIntegralVersion(t *testing.T) {
	for _, version := range []float64{1, 0, -1, 1.5} {
		block, ok := safeBlock(map[string]any{
			"type": "card", "cardId": "card-fixture", "cardType": "echo.release", "schemaVersion": version,
			"fallbackText": "synthetic", "payload": map[string]any{"private": "not an event field"}, "internal": "not an event field",
		})
		if !ok || block["cardId"] != "card-fixture" || block["cardType"] != "echo.release" {
			t.Fatal("card reference was lost")
		}
		if _, present := block["schemaVersion"]; present != (version == 1) {
			t.Fatalf("schema version presence=%v for %v", present, version)
		}
		for _, key := range []string{"payload", "internal"} {
			if _, leaked := block[key]; leaked {
				t.Fatalf("card event leaked non-reference field %s", key)
			}
		}
	}
	block, _ := safeBlock(map[string]any{"type": "text", "text": "synthetic", "cardId": "unrelated", "cardType": "echo.release", "schemaVersion": 1})
	for _, key := range []string{"cardId", "cardType", "schemaVersion"} {
		if _, present := block[key]; present {
			t.Fatalf("non-card block gained card field %s", key)
		}
	}
}
