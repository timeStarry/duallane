//go:build postgres_integration

package httpapi

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/conversations"
)

func TestConversationReadRouteReturnsAttachmentHydratedLatestMessage(t *testing.T) {
	database := newContractPGDatabase(t)
	conversationID := "read-attachment-route"
	messageID := "read-attachment-message"
	attachmentID := "read-attachment-file"
	if _, err := database.pool.Exec(database.ctx, `
		INSERT INTO conversations (
			id, space_id, type, title, direct_key, retention_count, created_by, created_at
		) VALUES ($1, $2, 'group', 'Read attachment route', NULL, 10000, $3, $4)
	`, conversationID, contractPGSpaceID, contractPGOwnerID, database.now); err != nil {
		t.Fatal(err)
	}
	if _, err := database.pool.Exec(database.ctx, `
		INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at)
		VALUES ($1, $2, $3, NULL), ($1, $4, $3, NULL)
	`, conversationID, contractPGOwnerID, database.now, contractPGMemberID); err != nil {
		t.Fatal(err)
	}
	contentJSON := `{"format":"duallane.message+json;v=1","plainText":"synthetic attachment","blocks":[{"type":"attachment","attachmentId":"read-attachment-file"}]}`
	if _, err := database.pool.Exec(database.ctx, `
		INSERT INTO messages (
			id, space_id, conversation_id, author_id, author_kind, kind,
			client_message_id, content_format, content_json, plain_text, created_at
		) VALUES ($1, $2, $3, $4, 'human', 'user', $5, 'duallane.message+json;v=1', $6, $7, $8)
	`, messageID, contractPGSpaceID, conversationID, contractPGOwnerID, "read-attachment-client", contentJSON, "synthetic attachment", database.now); err != nil {
		t.Fatal(err)
	}
	if _, err := database.pool.Exec(database.ctx, `
		INSERT INTO attachments (
			id, space_id, uploader_id, conversation_id, visibility, status,
			file_name, mime_type, byte_size, storage_key, created_at, completed_at
		) VALUES ($1, $2, $3, $4, 'conversation', 'available', $5, 'image/png', 68, NULL, $6, $6)
	`, attachmentID, contractPGSpaceID, contractPGOwnerID, conversationID, "synthetic.png", database.now); err != nil {
		t.Fatal(err)
	}
	if _, err := database.pool.Exec(database.ctx, `
		INSERT INTO message_attachments (message_id, attachment_id)
		VALUES ($1, $2)
	`, messageID, attachmentID); err != nil {
		t.Fatal(err)
	}

	conversationService := conversations.NewService(conversations.ServiceOptions{
		Repository: conversations.NewPGRepository(database.pool),
		SpaceID:    contractPGSpaceID,
		Now:        func() time.Time { return database.now },
	})
	router := database.router(RouterOptions{Conversations: conversationService})
	response := contractPGJSON(database, router, http.MethodPost, "/api/workspace/conversations/"+conversationID+"/read", "", contractPGMemberID, "read-attachment-route")
	if response.Code != http.StatusOK {
		t.Fatalf("read route status = %d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		Conversation conversations.Conversation `json:"conversation"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode read route response: %v", err)
	}
	if len(payload.Conversation.LatestMessages) != 1 {
		t.Fatalf("read route latest messages = %d, want one", len(payload.Conversation.LatestMessages))
	}
	message := payload.Conversation.LatestMessages[0]
	if len(message.Attachments) != 1 {
		t.Fatalf("read route attachments = %#v, want one", message.Attachments)
	}
	attachment := message.Attachments[0]
	if attachment.ID != attachmentID || attachment.MIMEType != "image/png" || attachment.Status != "available" || attachment.Visibility != "conversation" {
		t.Fatalf("read route attachment = %#v, want available image attachment", attachment)
	}
}
