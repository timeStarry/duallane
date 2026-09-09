package conversations

import (
	"context"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	workspaceMessages "github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

func TestConversationLatestProjectionHydratesReactionsAndHiddenState(t *testing.T) {
	now := time.Date(2026, 9, 7, 13, 0, 0, 0, time.UTC)
	actor := auth.Actor{ID: "usr-viewer", GitHubLogin: "viewer", DisplayName: "Viewer", Kind: "human", Role: "member", JoinedAt: now}
	repo := newConversationFake(actor)
	repo.state.members[actor.ID] = MemberRecord{ID: actor.ID, GitHubLogin: actor.GitHubLogin, DisplayName: actor.DisplayName, Kind: actor.Kind, Role: actor.Role, JoinedAt: now}
	repo.state.conversations["conversation-projection"] = ConversationRecord{
		ID: "conversation-projection", SpaceID: DefaultSpaceID, Type: string(ConversationTypeGroup),
		Title: "Projection", RetentionCount: DefaultRetentionCount, CreatedAt: now,
		LastActivityAt: now, MessageCount: 1, NotificationLevel: string(NotificationAll),
	}
	repo.state.conversationMembers["conversation-projection"] = map[string]bool{actor.ID: true}
	authorID := "usr-author"
	repo.state.messages["message-projection"] = MessageRecord{
		ID: "message-projection", ConversationID: "conversation-projection", AuthorID: &authorID,
		AuthorName: "Author", AuthorKind: "human", Kind: "user", PlainText: "hidden message", CreatedAt: now,
		HiddenByCurrentUser: true,
		Reactions: []workspaceMessages.ReactionGroup{{
			EmoteKey: "builtin:heart", Count: 1, ReactedByCurrentUser: true,
			Users: []workspaceMessages.ReactionUser{{ID: actor.ID, DisplayName: actor.DisplayName, CreatedAt: now.Format(time.RFC3339Nano)}},
		}},
	}
	service := NewService(ServiceOptions{Repository: repo, SpaceID: DefaultSpaceID, Now: func() time.Time { return now }})

	conversation, err := service.GetConversation(context.Background(), ConversationInput{ActorID: actor.ID, ConversationID: "conversation-projection"})
	if err != nil {
		t.Fatal(err)
	}
	if len(conversation.LatestMessages) != 1 {
		t.Fatalf("latest messages = %d, want one", len(conversation.LatestMessages))
	}
	message := conversation.LatestMessages[0]
	if !message.HiddenByCurrentUser {
		t.Fatalf("hiddenByCurrentUser = false, want true")
	}
	if len(message.Reactions) != 1 || message.Reactions[0].EmoteKey != "builtin:heart" || !message.Reactions[0].ReactedByCurrentUser {
		t.Fatalf("reactions = %#v, want viewer-bound reaction", message.Reactions)
	}
}

func TestPinProjectionsHydrateMessageRelationsAndOmitRecalledPin(t *testing.T) {
	now := time.Date(2026, 9, 7, 14, 0, 0, 0, time.UTC)
	actor := auth.Actor{ID: "usr-owner", GitHubLogin: "owner", DisplayName: "Owner", Kind: "human", Role: "owner", JoinedAt: now}
	repo := newConversationFake(actor)
	repo.state.members[actor.ID] = MemberRecord{ID: actor.ID, GitHubLogin: actor.GitHubLogin, DisplayName: actor.DisplayName, Kind: actor.Kind, Role: actor.Role, JoinedAt: now}
	conversationID := "group-projection"
	repo.state.conversations[conversationID] = ConversationRecord{
		ID: conversationID, SpaceID: DefaultSpaceID, Type: string(ConversationTypeGroup),
		Title: "Pins", RetentionCount: DefaultRetentionCount, CreatedAt: now,
		LastActivityAt: now, MessageCount: 2, NotificationLevel: string(NotificationAll),
	}
	repo.state.conversationMembers[conversationID] = map[string]bool{actor.ID: true}

	attachment := workspaceMessages.AttachmentRecord{
		ID: "pin-file", SpaceID: DefaultSpaceID, UploaderID: actor.ID, UploaderName: "Owner",
		ConversationID: &conversationID, Visibility: "conversation", Status: "available",
		FileName: "pin.png", MIMEType: "image/png", ByteSize: 32, CreatedAt: now,
	}
	reaction := workspaceMessages.ReactionGroup{EmoteKey: "builtin:star", Count: 1, ReactedByCurrentUser: true,
		Users: []workspaceMessages.ReactionUser{{ID: actor.ID, DisplayName: actor.DisplayName, CreatedAt: now.Format(time.RFC3339Nano)}}}

	messageID := "pin-message"
	repo.state.messages[messageID] = MessageRecord{
		ID: messageID, ConversationID: conversationID, AuthorID: &actor.ID,
		AuthorName: actor.DisplayName, AuthorKind: "human", Kind: "user", PlainText: "pinned", CreatedAt: now,
		Attachments: []workspaceMessages.AttachmentRecord{attachment}, Reactions: []workspaceMessages.ReactionGroup{reaction}, HiddenByCurrentUser: true,
	}
	repo.state.pins[conversationID+":"+messageID] = PinRecord{MessageID: messageID, PinnedByUserID: actor.ID, CreatedAt: now, Message: repo.state.messages[messageID]}

	service := NewService(ServiceOptions{Repository: repo, SpaceID: DefaultSpaceID, Now: func() time.Time { return now }})
	pins, err := service.ListPins(context.Background(), ConversationInput{ActorID: actor.ID, ConversationID: conversationID})
	if err != nil {
		t.Fatal(err)
	}
	if len(pins) != 1 {
		t.Fatalf("pins = %d, want one", len(pins))
	}
	projected := pins[0].Message
	if projected.Pin == nil || len(projected.Attachments) != 1 || projected.Attachments[0].ID != attachment.ID {
		t.Fatalf("listed pin projection = %#v, want pin and attachment", projected)
	}
	if projected.Attachments[0].UploaderName != attachment.UploaderName {
		t.Fatalf("listed pin uploaderName = %q, want %q", projected.Attachments[0].UploaderName, attachment.UploaderName)
	}
	if len(projected.Reactions) != 1 || !projected.HiddenByCurrentUser {
		t.Fatalf("listed pin relations = reactions:%#v hidden:%t", projected.Reactions, projected.HiddenByCurrentUser)
	}

	recalledAt := now.Add(time.Minute)
	recalledID := "recalled-pin-message"
	repo.state.messages[recalledID] = MessageRecord{
		ID: recalledID, ConversationID: conversationID, AuthorID: &actor.ID,
		AuthorName: actor.DisplayName, AuthorKind: "human", Kind: "user", PlainText: "recalled", CreatedAt: recalledAt,
		RecalledAt: &recalledAt,
	}
	repo.state.pins[conversationID+":"+recalledID] = PinRecord{MessageID: recalledID, PinnedByUserID: actor.ID, CreatedAt: recalledAt, Message: repo.state.messages[recalledID]}

	pins, err = service.ListPins(context.Background(), ConversationInput{ActorID: actor.ID, ConversationID: conversationID})
	if err != nil {
		t.Fatal(err)
	}
	var recalled Message
	for _, item := range pins {
		if item.MessageID == recalledID {
			recalled = item.Message
			break
		}
	}
	if recalled.ID == "" {
		t.Fatalf("recalled pin was not returned: %#v", pins)
	}
	if recalled.Pin != nil {
		t.Fatalf("recalled message pin = %#v, want omitted", recalled.Pin)
	}
}
