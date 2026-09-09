package events

import "testing"

func TestSafeCardBlockKeepsOnlyReferenceAndPositiveIntegralVersion(t *testing.T) {
	for _, version := range []float64{1, 0, -1, 1.5} {
		block, ok := safeBlock(map[string]any{
			"type": "card", "cardId": "card-fixture", "cardType": "echo.release", "schemaVersion": version,
			"fallbackText": "synthetic", "payload": map[string]any{"private": "not an event field"}, "internal": "not an event field",
		})
		if !ok {
			t.Fatal("card or its text fallback was lost")
		}
		if version == 1 {
			if block["type"] != "card" || block["cardId"] != "card-fixture" || block["cardType"] != "echo.release" || block["schemaVersion"] != 1 {
				t.Fatal("valid card reference was lost")
			}
		} else {
			if len(block) != 2 || block["type"] != "text" || block["text"] != "synthetic" {
				t.Fatalf("invalid version %v must use Node's text fallback", version)
			}
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
