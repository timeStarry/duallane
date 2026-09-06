package conversations

import (
	"context"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	workspaceMessages "github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

type conversationShareReaderFake struct {
	shares map[string]map[string]workspaceMessages.EmoteCollectionShare
	viewer string
	ids    []string
}

func (r *conversationShareReaderFake) ListMessageEmoteCollectionShares(_ context.Context, _ string, viewerID string, messageIDs []string) (map[string]map[string]workspaceMessages.EmoteCollectionShare, error) {
	r.viewer = viewerID
	r.ids = append([]string(nil), messageIDs...)
	return r.shares, nil
}

func TestConversationLatestAndPinProjectionsHydrateMessageShares(t *testing.T) {
	now := time.Date(2026, 9, 6, 2, 3, 4, 0, time.UTC)
	actor := auth.Actor{ID: "usr-owner", Kind: "human", Role: "owner", DisplayName: "Owner"}
	repo := newConversationFake(actor)
	repo.state.members[actor.ID] = MemberRecord{ID: actor.ID, Kind: "human", Role: "owner", DisplayName: actor.DisplayName}
	repo.state.conversations["group-1"] = ConversationRecord{
		ID: "group-1", SpaceID: DefaultSpaceID, Type: string(ConversationTypeGroup),
		Title: "Group", RetentionCount: DefaultRetentionCount, CreatedAt: now, LastActivityAt: now,
		NotificationLevel: string(NotificationAll),
	}
	repo.state.conversationMembers["group-1"] = map[string]bool{actor.ID: true}
	authorID := actor.ID
	repo.state.messages["message-1"] = MessageRecord{
		ID: "message-1", ConversationID: "group-1", AuthorID: &authorID, AuthorKind: "human", Kind: "user",
		ContentJSON: []byte(`{"format":"duallane.message+json;v=1","blocks":[{"type":"emote_collection","shareId":"share-1"}]}`),
		PlainText:   "[表情合集]", CreatedAt: now,
	}
	repo.state.pins["group-1:message-1"] = PinRecord{
		MessageID: "message-1", PinnedByUserID: actor.ID, CreatedAt: now, Message: repo.state.messages["message-1"],
	}
	reader := &conversationShareReaderFake{shares: map[string]map[string]workspaceMessages.EmoteCollectionShare{
		"message-1": {
			"share-1": {
				ID: "share-1", Name: "Shared", Covers: []workspaceMessages.EmoteCollectionShareCover{{ID: "cover-1", Src: "/assets/share.png"}},
			},
		},
	}}
	service := NewService(ServiceOptions{Repository: repo, MessageShareReader: reader, Now: func() time.Time { return now }})

	conversation, err := service.GetConversation(context.Background(), ConversationInput{ActorID: actor.ID, ConversationID: "group-1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(conversation.LatestMessages) != 1 || conversation.LatestMessages[0].Content.Blocks[0].Share == nil {
		t.Fatalf("latest message share = %#v", conversation.LatestMessages)
	}
	if reader.viewer != actor.ID || len(reader.ids) != 1 || reader.ids[0] != "message-1" {
		t.Fatalf("share reader call = viewer:%q ids:%v", reader.viewer, reader.ids)
	}

	pins, err := service.ListPins(context.Background(), ConversationInput{ActorID: actor.ID, ConversationID: "group-1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(pins) != 1 || pins[0].Message.Content.Blocks[0].Share == nil {
		t.Fatalf("pin share = %#v", pins)
	}
}
