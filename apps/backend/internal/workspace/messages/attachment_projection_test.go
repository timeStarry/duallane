package messages

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

func TestProjectMessageForViewerMatchesNodeAttachmentDTO(t *testing.T) {
	createdAt := time.Date(2026, 9, 7, 3, 4, 5, 678000000, time.FixedZone("CST", 8*60*60))
	completedAt := createdAt.Add(2 * time.Minute)
	conversationID := "conversation-attachment"
	attachmentRecord := AttachmentRecord{
		ID:             "attachment-1",
		SpaceID:        DefaultSpaceID,
		UploaderID:     "usr-uploader",
		UploaderName:   "Uploader as seen by viewer",
		ConversationID: &conversationID,
		Visibility:     "conversation",
		Status:         "available",
		FileName:       "report.txt",
		MIMEType:       "text/plain",
		ByteSize:       321,
		CreatedAt:      createdAt,
		CompletedAt:    &completedAt,
	}
	viewer := &auth.Actor{ID: "usr-viewer", DisplayName: "Viewer", Role: "member"}
	record := MessageRecord{
		ID:             "message-attachment",
		ConversationID: conversationID,
		AuthorKind:     "human",
		Kind:           "user",
		ContentJSON:    []byte(`{"format":"duallane.message+json;v=1","blocks":[{"type":"text","text":"file"}]}`),
		CreatedAt:      createdAt,
	}

	projected, err := ProjectMessageForViewer(record, []AttachmentRecord{attachmentRecord}, nil, viewer)
	if err != nil {
		t.Fatalf("ProjectMessageForViewer: %v", err)
	}
	if len(projected.Attachments) != 1 {
		t.Fatalf("attachments = %#v", projected.Attachments)
	}
	got := projected.Attachments[0]
	if got.ID != attachmentRecord.ID || got.FileName != attachmentRecord.FileName || got.MIMEType != attachmentRecord.MIMEType || got.ByteSize != attachmentRecord.ByteSize || got.Status != attachmentRecord.Status || got.Visibility != attachmentRecord.Visibility {
		t.Fatalf("basic attachment projection = %#v", got)
	}
	if got.UploaderID != attachmentRecord.UploaderID || got.UploaderName != attachmentRecord.UploaderName || got.Uploader.ID != attachmentRecord.UploaderID || got.Uploader.DisplayName != attachmentRecord.UploaderName {
		t.Fatalf("uploader projection = %#v", got)
	}
	if got.ConversationID == nil || *got.ConversationID != conversationID {
		t.Fatalf("conversationId = %v", got.ConversationID)
	}
	if got.CreatedAt != "2026-09-06T19:04:05.678Z" || got.CompletedAt == nil || *got.CompletedAt != "2026-09-06T19:06:05.678Z" || got.AvailableAt == nil || *got.AvailableAt != "2026-09-06T19:06:05.678Z" {
		t.Fatalf("attachment timestamps = %#v", got)
	}
	if got.Capabilities != (AttachmentCapabilities{CanDownload: true, CanRemove: false}) {
		t.Fatalf("member capabilities = %#v", got.Capabilities)
	}

	owner := &auth.Actor{ID: "usr-owner", DisplayName: "Owner", Role: "owner"}
	ownerMessage, err := ProjectMessageForViewer(record, []AttachmentRecord{attachmentRecord}, nil, owner)
	if err != nil {
		t.Fatalf("owner ProjectMessageForViewer: %v", err)
	}
	if !ownerMessage.Attachments[0].Capabilities.CanRemove {
		t.Fatalf("owner canRemove = false, attachment = %#v", ownerMessage.Attachments[0])
	}

	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal attachment: %v", err)
	}
	for _, forbidden := range []string{"storageKey", "storageObject", "sha256", "digest", "uploadTransferId", "objectKey"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("attachment leaked %q: %s", forbidden, encoded)
		}
	}
}

func TestProjectMessageForViewerAttachmentCapabilitiesFollowNodeStatusAndActor(t *testing.T) {
	createdAt := time.Date(2026, 9, 7, 3, 4, 5, 0, time.UTC)
	record := MessageRecord{
		ID:             "message-attachment-status",
		ConversationID: "conversation-attachment-status",
		AuthorKind:     "human",
		Kind:           "user",
		ContentJSON:    []byte(`{"format":"duallane.message+json;v=1","blocks":[]}`),
		CreatedAt:      createdAt,
	}
	viewer := &auth.Actor{ID: "usr-viewer", DisplayName: "Viewer", Role: "member"}
	for _, status := range []string{"pending", "failed", "removed"} {
		t.Run(status, func(t *testing.T) {
			projected, err := ProjectMessageForViewer(record, []AttachmentRecord{{
				ID:         "attachment-" + status,
				UploaderID: "usr-viewer",
				Status:     status,
				CreatedAt:  createdAt,
			}}, nil, viewer)
			if err != nil {
				t.Fatalf("ProjectMessageForViewer: %v", err)
			}
			capabilities := projected.Attachments[0].Capabilities
			if capabilities.CanDownload || capabilities.CanRemove {
				t.Fatalf("status %q capabilities = %#v", status, capabilities)
			}
		})
	}
}

func TestProjectMessageForViewerDoesNotGrantCapabilitiesWithoutViewer(t *testing.T) {
	createdAt := time.Date(2026, 9, 7, 3, 4, 5, 0, time.UTC)
	projected, err := ProjectMessageForViewer(MessageRecord{
		ID:             "message-attachment-no-viewer",
		ConversationID: "conversation-attachment-no-viewer",
		AuthorKind:     "human",
		Kind:           "user",
		ContentJSON:    []byte(`{"format":"duallane.message+json;v=1","blocks":[]}`),
		CreatedAt:      createdAt,
	}, []AttachmentRecord{{
		ID:         "attachment-no-viewer",
		UploaderID: "usr-uploader",
		Status:     "available",
		CreatedAt:  createdAt,
	}}, nil, nil)
	if err != nil {
		t.Fatalf("ProjectMessageForViewer: %v", err)
	}
	if projected.Attachments[0].Capabilities.CanRemove {
		t.Fatalf("nil viewer received canRemove: %#v", projected.Attachments[0])
	}
}

func TestListMessagesPassesAuthenticatedViewerToAttachmentProjector(t *testing.T) {
	repo := newFakeRepo()
	seedConversation(repo, "usr-alice")
	createdAt := time.Date(2026, 9, 7, 3, 4, 5, 0, time.UTC)
	seedMessage(repo, "message-service-attachment", createdAt, "file")
	repo.attachments["attachment-service"] = &AttachmentRecord{
		ID:           "attachment-service",
		UploaderID:   "usr-alice",
		UploaderName: "Alice as seen by Alice",
		Status:       "available",
		Visibility:   "conversation",
		FileName:     "service.txt",
		MIMEType:     "text/plain",
		ByteSize:     12,
		CreatedAt:    createdAt,
		CompletedAt:  timePointer(createdAt.Add(time.Minute)),
	}
	repo.messageFiles["message-service-attachment"] = []string{"attachment-service"}

	projected, err := testService(repo).ListMessages(context.Background(), ListOptions{
		ActorID:        "usr-alice",
		ConversationID: "conv-1",
		Limit:          1,
	})
	if err != nil {
		t.Fatalf("ListMessages: %v", err)
	}
	if len(projected) != 1 || len(projected[0].Attachments) != 1 {
		t.Fatalf("projected messages = %#v", projected)
	}
	attachment := projected[0].Attachments[0]
	if attachment.UploaderName != "Alice as seen by Alice" || !attachment.Capabilities.CanDownload || !attachment.Capabilities.CanRemove {
		t.Fatalf("service attachment projection = %#v", attachment)
	}
}
