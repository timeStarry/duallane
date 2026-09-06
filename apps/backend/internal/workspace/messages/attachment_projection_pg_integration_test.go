//go:build postgres_integration

package messages

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

func TestPGMessageAttachmentProjectionUsesViewerRemark(t *testing.T) {
	fixture := newPGMessageIntegrationFixture(t)
	repository, ok := fixture.service.Repository().(*PGRepository)
	if !ok {
		t.Fatal("message repository is not PostgreSQL")
	}

	messageID := "message-attachment-public"
	attachmentID := "attachment-public"
	mustExecPGMessageIntegrationPool(t, fixture, `
		INSERT INTO messages (
			id, space_id, conversation_id, author_id, author_kind, kind,
			client_message_id, content_format, content_json, plain_text, created_at
		) VALUES ($1, $2, 'conv-messages', 'usr-alice', 'human', 'user', $3, $4, $5, 'attachment', $6)
	`, messageID, DefaultSpaceID, "client-attachment-public", MessageContentFormat,
		`{"format":"duallane.message+json;v=1","plainText":"attachment","blocks":[{"type":"attachment","attachmentId":"attachment-public"}]}`,
		fixture.now)
	mustExecPGMessageIntegrationPool(t, fixture, `
		INSERT INTO attachments (
			id, space_id, uploader_id, conversation_id, visibility, status,
			file_name, mime_type, byte_size, created_at, completed_at
		) VALUES ($1, $2, 'usr-alice', 'conv-messages', 'conversation', 'available', 'report.txt', 'text/plain', 321, $3, $3)
	`, attachmentID, DefaultSpaceID, fixture.now)
	mustExecPGMessageIntegrationPool(t, fixture, `
		INSERT INTO message_attachments (message_id, attachment_id)
		VALUES ($1, $2)
	`, messageID, attachmentID)
	mustExecPGMessageIntegrationPool(t, fixture, `
		INSERT INTO user_remarks (owner_user_id, target_user_id, remark, updated_at)
		VALUES ('usr-bob', 'usr-alice', 'Alice as seen by Bob', $1)
	`, fixture.now)

	memberRows, err := repository.ListAttachments(fixture.ctx, DefaultSpaceID, "usr-bob", []string{messageID})
	if err != nil {
		t.Fatalf("member ListAttachments: %v", err)
	}
	memberAttachments := memberRows[messageID]
	if len(memberAttachments) != 1 || memberAttachments[0].UploaderName != "Alice as seen by Bob" {
		t.Fatalf("member attachment rows = %#v", memberAttachments)
	}

	record := MessageRecord{
		ID:             messageID,
		ConversationID: "conv-messages",
		AuthorID:       stringPointerValue("usr-alice"),
		AuthorName:     "Alice",
		AuthorKind:     "human",
		Kind:           "user",
		ContentJSON:    []byte(`{"format":"duallane.message+json;v=1","blocks":[]}`),
		CreatedAt:      fixture.now,
	}
	memberMessage, err := ProjectMessageForViewer(record, memberAttachments, nil, &auth.Actor{ID: "usr-bob", DisplayName: "Bob", Role: "member"})
	if err != nil {
		t.Fatalf("member projection: %v", err)
	}
	memberAttachment := memberMessage.Attachments[0]
	if memberAttachment.UploaderName != "Alice as seen by Bob" || memberAttachment.Uploader.DisplayName != "Alice as seen by Bob" {
		t.Fatalf("member uploader projection = %#v", memberAttachment)
	}
	if memberAttachment.Capabilities != (AttachmentCapabilities{CanDownload: true, CanRemove: false}) {
		t.Fatalf("member capabilities = %#v", memberAttachment.Capabilities)
	}

	ownerRows, err := repository.ListAttachments(fixture.ctx, DefaultSpaceID, "usr-alice", []string{messageID})
	if err != nil {
		t.Fatalf("owner ListAttachments: %v", err)
	}
	ownerAttachments := ownerRows[messageID]
	if len(ownerAttachments) != 1 || ownerAttachments[0].UploaderName != "Alice" {
		t.Fatalf("owner attachment rows = %#v", ownerAttachments)
	}
	ownerMessage, err := ProjectMessageForViewer(record, ownerAttachments, nil, &auth.Actor{ID: "usr-alice", DisplayName: "Alice", Role: "owner"})
	if err != nil {
		t.Fatalf("owner projection: %v", err)
	}
	if !ownerMessage.Attachments[0].Capabilities.CanRemove {
		t.Fatalf("owner canRemove = false: %#v", ownerMessage.Attachments[0])
	}

	encoded, err := json.Marshal(memberMessage)
	if err != nil {
		t.Fatalf("marshal member message: %v", err)
	}
	for _, forbidden := range []string{"storageKey", "storageObject", "sha256", "digest", "uploadTransferId", "objectKey"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("message attachment leaked %q: %s", forbidden, encoded)
		}
	}
}
