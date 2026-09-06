package conversations

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	workspaceMessages "github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

func TestMarkReadProjectsLatestMessageAttachments(t *testing.T) {
	now := time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC)
	conversationID := "conversation-with-file"
	actor := auth.Actor{
		ID:          "usr-read-member",
		GitHubLogin: "read-member",
		DisplayName: "Read Member",
		Kind:        "human",
		Role:        "member",
		JoinedAt:    now,
	}
	repo := newConversationFake(actor)
	repo.state.members[actor.ID] = MemberRecord{
		ID: actor.ID, GitHubLogin: actor.GitHubLogin, DisplayName: actor.DisplayName,
		Kind: actor.Kind, Role: actor.Role, JoinedAt: now,
	}
	repo.state.conversations[conversationID] = ConversationRecord{
		ID: conversationID, SpaceID: DefaultSpaceID, Type: string(ConversationTypeGroup),
		Title: "Attachment projection", RetentionCount: DefaultRetentionCount,
		CreatedAt: now, LastActivityAt: now.Add(time.Minute), MessageCount: 1,
		UnreadCount: 1, NotificationLevel: string(NotificationAll),
	}
	repo.state.conversationMembers[conversationID] = map[string]bool{actor.ID: true}
	contentJSON, err := json.Marshal(workspaceMessages.Content{
		Format:    workspaceMessages.MessageContentFormat,
		PlainText: "file message",
		Blocks:    []workspaceMessages.Block{{Type: "attachment", AttachmentID: "attachment-1"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	repo.state.messages["message-with-file"] = MessageRecord{
		ID: "message-with-file", ConversationID: conversationID, AuthorID: &actor.ID,
		AuthorName: actor.DisplayName, AuthorKind: "human", Kind: "user", ContentJSON: contentJSON,
		PlainText: "file message", CreatedAt: now.Add(time.Minute),
		Attachments: []workspaceMessages.AttachmentRecord{{
			ID: "attachment-1", SpaceID: DefaultSpaceID, UploaderID: actor.ID,
			ConversationID: &conversationID, Visibility: "conversation",
			Status: "available", FileName: "synthetic.png", MIMEType: "image/png", ByteSize: 68,
			CreatedAt: now.Add(time.Minute),
		}},
	}

	service := NewService(ServiceOptions{
		Repository: repo,
		SpaceID:    DefaultSpaceID,
		Now:        func() time.Time { return now.Add(2 * time.Minute) },
	})
	read, err := service.MarkRead(context.Background(), ConversationInput{
		ActorID: actor.ID, ConversationID: conversationID,
		Meta: auth.RequestMeta{RequestID: "read-attachment-projection"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(read.LatestMessages) != 1 {
		t.Fatalf("latest messages = %d, want one", len(read.LatestMessages))
	}
	message := read.LatestMessages[0]
	if len(message.Attachments) != 1 {
		t.Fatalf("read message attachments = %#v, want one attachment", message.Attachments)
	}
	attachment := message.Attachments[0]
	if attachment.ID != "attachment-1" || attachment.MIMEType != "image/png" || attachment.Status != "available" || attachment.Visibility != "conversation" {
		t.Fatalf("read attachment = %#v, want authorized attachment metadata", attachment)
	}
	if message.Content.Blocks[0].AttachmentID != attachment.ID {
		t.Fatalf("attachment block id = %q, want %q", message.Content.Blocks[0].AttachmentID, attachment.ID)
	}
}
