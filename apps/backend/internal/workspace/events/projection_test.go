package events

import "testing"

func TestSafeConversationPreservesViewerReadState(t *testing.T) {
	projected, ok := safeConversation(map[string]any{
		"id":                "conv-read-state",
		"spaceId":           DefaultSpaceID,
		"type":              "group",
		"title":             "Read state",
		"unreadCount":       int64(2),
		"lastReadMessageId": "msg-read",
		"lastReadAt":        "2026-09-06T00:00:01.000Z",
		"lastReadSeq":       int64(7),
		"members":           []any{},
	}, "usr-viewer")
	if !ok {
		t.Fatal("conversation projection was rejected")
	}
	if got := projected["unreadCount"]; got != int64(2) {
		t.Fatalf("unreadCount = %#v, want 2", got)
	}
	if got := projected["lastReadMessageId"]; got != "msg-read" {
		t.Fatalf("lastReadMessageId = %#v, want msg-read", got)
	}
	if got := projected["lastReadAt"]; got != "2026-09-06T00:00:01.000Z" {
		t.Fatalf("lastReadAt = %#v, want timestamp", got)
	}
	if got := projected["lastReadSeq"]; got != int64(7) {
		t.Fatalf("lastReadSeq = %#v, want 7", got)
	}
}

func TestSafeConversationPreservesNullReadState(t *testing.T) {
	projected, ok := safeConversation(map[string]any{
		"id":                "conv-no-read",
		"type":              "group",
		"unreadCount":       int64(1),
		"lastReadMessageId": nil,
		"lastReadAt":        nil,
		"lastReadSeq":       nil,
	}, "usr-viewer")
	if !ok {
		t.Fatal("conversation projection was rejected")
	}
	for _, key := range []string{"lastReadMessageId", "lastReadAt", "lastReadSeq"} {
		value, exists := projected[key]
		if !exists || value != nil {
			t.Fatalf("%s = (%#v, exists=%v), want explicit null", key, value, exists)
		}
	}
}
