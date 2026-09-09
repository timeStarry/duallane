package messages

import (
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

func TestMessagePinCapabilityUsesViewerAndMessageAuthor(t *testing.T) {
	createdAt := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	authorID, pinnedBy := "author", "legacy-pin-creator"
	for _, test := range []struct {
		name   string
		viewer *auth.Actor
		want   bool
	}{
		{"author", &auth.Actor{ID: authorID, Role: "member"}, true},
		{"owner", &auth.Actor{ID: "owner", Role: "owner"}, true},
		{"admin", &auth.Actor{ID: "admin", Role: "admin"}, true},
		{"other member", &auth.Actor{ID: "member", Role: "member"}, false},
		{"pin creator is not author", &auth.Actor{ID: pinnedBy, Role: "member"}, false},
		{"no viewer", nil, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			record := MessageRecord{
				ID: "message", AuthorID: &authorID, AuthorKind: "human", CreatedAt: createdAt,
				PinnedByUserID: &pinnedBy, PinnedAt: &createdAt,
				ContentJSON: []byte(`{"format":"duallane.message+json;v=1","blocks":[{"type":"text","text":"content"}]}`),
			}
			projected, err := ProjectMessageForViewer(record, nil, nil, test.viewer)
			if err != nil {
				t.Fatal(err)
			}
			if projected.Pin == nil || projected.Pin.CanUnpin != test.want || projected.Pin.PinnedByUserID != pinnedBy {
				t.Fatalf("pin projection = %+v, want canUnpin=%v", projected.Pin, test.want)
			}
			record.RecalledAt = &createdAt
			projected, err = ProjectMessageForViewer(record, nil, nil, test.viewer)
			if err != nil || projected.Pin != nil {
				t.Fatal("recalled message exposes pin")
			}
		})
	}
}
