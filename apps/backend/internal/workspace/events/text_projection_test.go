package events

import (
	"reflect"
	"testing"
)

func TestSafeContentPreservesEmptyAndWhitespaceTextBytes(t *testing.T) {
	for _, text := range []string{"", "\n", "  \t\n", "  **markdown**\n  "} {
		projected, ok := safeContent(map[string]any{
			"format": "duallane.message+json;v=1",
			"blocks": []any{map[string]any{"type": "text", "text": text}},
		})
		if !ok {
			t.Fatal("content projection rejected a text block")
		}
		blocks := projected["blocks"].([]any)
		if len(blocks) != 1 {
			t.Fatal("content projection dropped a text block")
		}
		block := blocks[0].(map[string]any)
		if actual, exists := block["text"]; !exists || actual != text {
			t.Fatalf("text bytes = %#v, want %q", actual, text)
		}
	}
}

func TestSafeBlockMatchesNodeTypeAllowlist(t *testing.T) {
	const rawText = "  **raw text**\n  "
	allCrossTypeFields := map[string]any{
		"text":          rawText,
		"userId":        "user-1",
		"label":         "label",
		"url":           "https://example.test",
		"shortcode":     "wave",
		"attachmentId":  "attachment-1",
		"shareId":       "share-1",
		"share":         map[string]any{"id": "share-1", "private": "must-not-leak"},
		"topicId":       "topic-1",
		"title":         "topic title",
		"fallbackText":  "fallback",
		"cardId":        "card-1",
		"cardType":      "echo.release",
		"schemaVersion": 1,
		"private":       "must-not-leak",
	}

	tests := []struct {
		name  string
		input map[string]any
		want  map[string]any
	}{
		{
			name:  "text preserves valid raw text",
			input: withFields("text", allCrossTypeFields),
			want:  map[string]any{"type": "text", "text": rawText},
		},
		{
			name:  "mention",
			input: withFields("mention", allCrossTypeFields),
			want:  map[string]any{"type": "mention", "userId": "user-1", "label": "label"},
		},
		{
			name:  "link",
			input: withFields("link", allCrossTypeFields),
			want:  map[string]any{"type": "link", "url": "https://example.test", "label": "label"},
		},
		{
			name:  "emoji",
			input: withFields("emoji", allCrossTypeFields),
			want:  map[string]any{"type": "emoji", "shortcode": "wave"},
		},
		{
			name:  "attachment",
			input: withFields("attachment", allCrossTypeFields),
			want:  map[string]any{"type": "attachment", "attachmentId": "attachment-1"},
		},
		{
			name:  "emote collection",
			input: withFields("emote_collection", allCrossTypeFields),
			want: map[string]any{
				"type":    "emote_collection",
				"shareId": "share-1",
				"share":   map[string]any{"id": "share-1"},
			},
		},
		{
			name:  "topic reference",
			input: withFields("topic_reference", allCrossTypeFields),
			want:  map[string]any{"type": "topic_reference", "topicId": "topic-1", "title": "topic title"},
		},
		{
			name: "card reference",
			input: withFields("card", map[string]any{
				"cardId":        " card-1 ",
				"cardType":      " Echo.Release ",
				"schemaVersion": 1,
				"fallbackText":  " fallback ",
			}),
			want: map[string]any{
				"type":          "card",
				"cardId":        "card-1",
				"cardType":      "echo.release",
				"schemaVersion": 1,
				"fallbackText":  "fallback",
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := safeBlock(test.input)
			if !ok {
				t.Fatal("safeBlock rejected a valid Node block type")
			}
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("projected block = %#v, want %#v", got, test.want)
			}
		})
	}

	if _, ok := safeBlock(withFields("future_block", allCrossTypeFields)); ok {
		t.Fatal("unknown block type was projected")
	}
}

func TestSafeBlockUsesNodeCardFallbackForInvalidReferences(t *testing.T) {
	tests := []struct {
		name  string
		input map[string]any
		want  map[string]any
		ok    bool
	}{
		{
			name: "missing card id falls back to text",
			input: map[string]any{
				"type": "card", "cardType": "echo.release", "schemaVersion": 1, "fallbackText": "  fallback  ",
			},
			want: map[string]any{"type": "text", "text": "fallback"}, ok: true,
		},
		{
			name: "invalid schema falls back to text",
			input: map[string]any{
				"type": "card", "cardId": "card-1", "cardType": "echo.release", "schemaVersion": "1", "fallbackText": "fallback",
			},
			want: map[string]any{"type": "text", "text": "fallback"}, ok: true,
		},
		{
			name: "invalid card without fallback is dropped",
			input: map[string]any{
				"type": "card", "cardType": "echo.release", "schemaVersion": 1,
			},
			want: nil, ok: false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := safeBlock(test.input)
			if ok != test.ok || !reflect.DeepEqual(got, test.want) {
				t.Fatalf("safeBlock = (%#v, %v), want (%#v, %v)", got, ok, test.want, test.ok)
			}
		})
	}
}

func TestSafeBlockUsesNodePublicStringForInvalidText(t *testing.T) {
	block, ok := safeBlock(map[string]any{
		"type":        "text",
		"text":        []any{"not", "a", "string"},
		"textType":    "forged-text-type",
		"forgedField": "forged-value",
		"internal":    map[string]any{"secret": "value"},
	})
	if !ok {
		t.Fatal("safeBlock rejected a valid text block")
	}
	if got, want := block["text"], ""; got != want {
		t.Fatalf("non-string text = %#v, want empty string", got)
	}
	for _, key := range []string{"textType", "forgedField", "internal"} {
		if _, exists := block[key]; exists {
			t.Fatalf("forged field %q was projected", key)
		}
	}
}

func TestSafeContentRebuildsPlainTextFromProjectedBlocks(t *testing.T) {
	projected, ok := safeContent(map[string]any{
		"format":    "  duallane.message+json;v=1  ",
		"plainText": "PRIVATE-UNTRUSTED-PLAINTEXT",
		"blocks": []any{
			map[string]any{"type": "text", "text": "  hello  "},
			map[string]any{"type": "mention", "label": "Ada"},
			map[string]any{"type": "link", "url": "https://example.test", "label": "docs"},
			map[string]any{"type": "emoji", "shortcode": "wave"},
			map[string]any{"type": "attachment", "attachmentId": "attachment-1"},
			map[string]any{"type": "emote_collection", "shareId": "share-1"},
			map[string]any{"type": "topic_reference", "topicId": "topic-1", "title": "Topic"},
			map[string]any{"type": "card", "cardId": "card-1", "cardType": "echo.release", "schemaVersion": 1, "fallbackText": "fallback"},
			map[string]any{"type": "unknown", "text": "MUST-NOT-APPEAR"},
		},
	})
	if !ok {
		t.Fatal("safeContent rejected a valid content envelope")
	}
	if got, want := projected["format"], "  duallane.message+json;v=1  "; got != want {
		t.Fatalf("format = %#v, want %#v", got, want)
	}
	if got, want := projected["plainText"], "hello @Adadocs:wave:[文件][表情合集]#Topicfallback"; got != want {
		t.Fatalf("plainText = %#v, want %#v", got, want)
	}
	if got := projected["plainText"].(string); got == "PRIVATE-UNTRUSTED-PLAINTEXT" || got == "MUST-NOT-APPEAR" {
		t.Fatalf("untrusted plaintext survived projection: %q", got)
	}
	blocks := projected["blocks"].([]any)
	if len(blocks) != 8 {
		t.Fatalf("projected block count = %d, want 8", len(blocks))
	}
}

func TestSafeMessageUsesProjectedContentPlainText(t *testing.T) {
	message, ok := safeMessage(map[string]any{
		"plainText": "PRIVATE-OUTER-PLAINTEXT",
		"content": map[string]any{
			"plainText": "PRIVATE-INNER-PLAINTEXT",
			"blocks":    []any{map[string]any{"type": "text", "text": "safe"}},
		},
	}, "viewer")
	if !ok {
		t.Fatal("safeMessage rejected a valid message")
	}
	if got, want := message["plainText"], "safe"; got != want {
		t.Fatalf("message plainText = %#v, want %#v", got, want)
	}
}

func withFields(typeName string, fields map[string]any) map[string]any {
	result := make(map[string]any, len(fields)+1)
	for key, value := range fields {
		result[key] = value
	}
	result["type"] = typeName
	return result
}
