package messages

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestProjectMessageHydratesOnlyReferencedShareAndDropsClientMetadata(t *testing.T) {
	createdAt := time.Date(2026, 9, 6, 1, 2, 3, 4_000_000, time.UTC)
	share := EmoteCollectionShare{
		ID: "share-authorized", Name: "Authorized", ItemCount: 2,
		CreatedAt:       formatTimestamp(createdAt),
		SharedBy:        EmoteCollectionSharePerson{ID: "usr-owner", DisplayName: "Owner"},
		OriginalCreator: EmoteCollectionSharePerson{ID: "usr-creator", DisplayName: "Creator"},
		Covers:          []EmoteCollectionShareCover{{ID: "cover-1", Label: "Builtin", Src: "/assets/builtin.png"}},
		SharePath:       "/workspace/emotes/shared/share-authorized",
	}
	record := MessageRecord{
		ID:             "message-1",
		ConversationID: "conversation-1",
		AuthorKind:     "human",
		Kind:           "user",
		ContentJSON: []byte(`{"format":"duallane.message+json;v=1","plainText":"","blocks":[` +
			`{"type":"emote_collection","shareId":"share-authorized","share":{"id":"forged","name":"client forged"}},` +
			`{"type":"emote_collection","shareId":"share-not-referenced","share":{"id":"forged-2","name":"client forged 2"}}]}`),
		CreatedAt: createdAt,
		EmoteCollectionShares: map[string]EmoteCollectionShare{
			"share-authorized": share,
			// This row is intentionally not referenced by content. It must not
			// appear anywhere in the projected blocks.
			"share-unreferenced": {ID: "share-unreferenced", Name: "Do not leak"},
		},
	}

	projected, err := ProjectMessage(record, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(projected.Content.Blocks) != 2 {
		t.Fatalf("blocks = %d, want 2", len(projected.Content.Blocks))
	}
	if got := projected.Content.Blocks[0].Share; got == nil || got.ID != share.ID || got.Name != share.Name {
		t.Fatalf("authorized share = %#v", got)
	}
	if got := projected.Content.Blocks[1].Share; got != nil {
		t.Fatalf("unreferenced share leaked: %#v", got)
	}
	if projected.Content.Blocks[0].Share.Covers[0].Src != "/assets/builtin.png" {
		t.Fatalf("cover source = %q", projected.Content.Blocks[0].Share.Covers[0].Src)
	}

	encoded, err := json.Marshal(projected.Content)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) == "" || containsJSONString(encoded, "client forged") || containsJSONString(encoded, "Do not leak") {
		t.Fatalf("projected content retained untrusted share data: %s", encoded)
	}
}

func TestProjectContentDoesNotUseShareIDAsMetadataLookup(t *testing.T) {
	content, err := ProjectContent([]byte(`{"format":"duallane.message+json;v=1","blocks":[{"type":"emote_collection","shareId":"arbitrary-share"}]}`), "", map[string]EmoteCollectionShare{
		"other-share": {ID: "other-share", Name: "secret"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(content.Blocks) != 1 || content.Blocks[0].Share != nil {
		t.Fatalf("arbitrary share metadata leaked: %#v", content.Blocks)
	}
}

func containsJSONString(value []byte, needle string) bool {
	return len(needle) > 0 && json.Valid(value) && strings.Contains(string(value), needle)
}

func TestCustomShareCoverPreservesExplicitFalseAnimation(t *testing.T) {
	cover, ok := messageShareCover(context.Background(), nil, "static", "upload", "", "Static", nil)
	if !ok {
		t.Fatal("static uploaded cover was omitted")
	}
	encoded, err := json.Marshal(cover)
	if err != nil || !strings.Contains(string(encoded), `"animated":false`) {
		t.Fatalf("Node static cover shape = %s, %v", encoded, err)
	}
}
