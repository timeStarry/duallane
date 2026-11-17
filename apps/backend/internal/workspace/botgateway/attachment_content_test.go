package botgateway

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func attachmentReadFixture(t *testing.T) (*fakeRepository, *Service, *Auth, AttachmentReadInput) {
	t.Helper()
	repo, service, _, _, _ := gatewayFixture(t)
	repo.auth.Scopes = append(repo.auth.Scopes, ScopeFilesReadContent, ScopeFilesReadPreview)
	value := cloneFakeAuth(repo.auth)
	conversationID := "conv_direct"
	repo.attachments["att_input"] = &AttachmentRecord{ID: "att_input", SpaceID: value.SpaceID, UploaderID: "owner_1", ConversationID: &conversationID, Visibility: "conversation", Status: "available", FileName: "input.txt", MIMEType: "text/plain", ByteSize: 5}
	repo.context[conversationID] = []ContextMessageRecord{{ID: "msg_input", ConversationID: conversationID, AuthorKind: "human", PlainText: "private content", ContentJSON: []byte(`{"blocks":[{"type":"attachment","attachmentId":"att_input","fileName":"private filename","storageKey":"must-not-project"}]}`), CreatedAt: repo.now()}}
	repo.settings.AllowAttachmentPreview = true
	return repo, service, value, AttachmentReadInput{ConversationID: conversationID, AttachmentID: "att_input", MessageID: "msg_input", Mode: "content"}
}

func TestAgentAttachmentReadRequiresCurrentSourceScopeAndGrant(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*fakeRepository, *AttachmentReadInput)
	}{
		{"missing-file-scope", func(r *fakeRepository, _ *AttachmentReadInput) { r.auth.Scopes = []string{ScopeMessagesReadContext} }},
		{"missing-context-scope", func(r *fakeRepository, _ *AttachmentReadInput) { r.auth.Scopes = []string{ScopeFilesReadContent} }},
		{"missing-explicit-direct-grant", func(r *fakeRepository, _ *AttachmentReadInput) { delete(r.grants, "conv_direct") }},
		{"revoked-grant", func(r *fakeRepository, _ *AttachmentReadInput) { r.grants["conv_direct"].AllowContext = false }},
		{"removed-membership", func(r *fakeRepository, _ *AttachmentReadInput) { r.members["conv_direct:bot_user"] = false }},
		{"unapproved-group", func(r *fakeRepository, _ *AttachmentReadInput) { r.conversations["conv_direct"].Type = "group" }},
		{"removed-file", func(r *fakeRepository, _ *AttachmentReadInput) { r.attachments["att_input"].Status = "removed" }},
		{"private-staging", func(r *fakeRepository, _ *AttachmentReadInput) {
			r.attachments["att_input"].Visibility = "private_staging"
		}},
		{"cross-conversation-file", func(r *fakeRepository, _ *AttachmentReadInput) {
			v := "other"
			r.attachments["att_input"].ConversationID = &v
		}},
		{"unlinked-source", func(_ *fakeRepository, in *AttachmentReadInput) { in.MessageID = "another-message" }},
		{"source-outside-context", func(r *fakeRepository, _ *AttachmentReadInput) { r.context["conv_direct"] = nil }},
		{"unknown-mode", func(_ *fakeRepository, in *AttachmentReadInput) { in.Mode = "raw" }},
		{"over-limit", func(r *fakeRepository, _ *AttachmentReadInput) {
			r.attachments["att_input"].ByteSize = MaxAgentAttachmentContentBytes + 1
		}},
		{"active-document", func(r *fakeRepository, _ *AttachmentReadInput) { r.attachments["att_input"].MIMEType = "image/svg+xml" }},
		{"preview-policy", func(r *fakeRepository, in *AttachmentReadInput) {
			in.Mode = "preview"
			r.settings.AllowAttachmentPreview = false
		}},
		{"preview-image", func(r *fakeRepository, in *AttachmentReadInput) {
			in.Mode = "preview"
			r.attachments["att_input"].MIMEType = "image/png"
		}},
		{"preview-size", func(r *fakeRepository, in *AttachmentReadInput) {
			in.Mode = "preview"
			r.attachments["att_input"].ByteSize = MaxAgentAttachmentPreviewBytes + 1
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo, service, value, input := attachmentReadFixture(t)
			tc.mutate(repo, &input)
			if _, err := service.AuthorizeAttachmentRead(context.Background(), value, input); err == nil {
				t.Fatal("unauthorized read accepted")
			}
			if len(repo.audits) != 1 || repo.audits[0].Result != "rejected" {
				t.Fatalf("rejection not audited: %+v", repo.audits)
			}
			audit, _ := json.Marshal(repo.audits)
			if strings.Contains(string(audit), "private content") || strings.Contains(string(audit), "private filename") {
				t.Fatal("audit contains content")
			}
		})
	}
	repo, service, value, input := attachmentReadFixture(t)
	for _, mode := range []string{"content", "preview"} {
		input.Mode = mode
		got, err := service.AuthorizeAttachmentRead(context.Background(), value, input)
		if err != nil || got.ID != "att_input" {
			t.Fatalf("authorized %s: %+v %v", mode, got, err)
		}
	}
	repo.valid = false
	if _, err := service.AuthorizeAttachmentRead(context.Background(), value, input); err == nil {
		t.Fatal("revoked token accepted")
	}
}

func TestAgentAttachmentMetadataDoesNotExposeUnscopedObjects(t *testing.T) {
	for _, change := range []func(*AttachmentRecord){
		func(a *AttachmentRecord) { a.Status = "pending" },
		func(a *AttachmentRecord) { a.Status = "removed" },
		func(a *AttachmentRecord) { a.Visibility = "private_staging" },
		func(a *AttachmentRecord) { a.ConversationID = nil },
	} {
		repo, service, value, _ := attachmentReadFixture(t)
		change(repo.attachments["att_input"])
		if _, err := service.GetAttachment(context.Background(), value, "att_input"); err == nil {
			t.Fatal("unscoped metadata exposed")
		}
	}
}

func TestContextAttachmentMetadataIntersectsFileScope(t *testing.T) {
	repo, service, value, _ := attachmentReadFixture(t)
	repo.settings.IncludeAttachmentMetadata = true
	repo.auth.Scopes = []string{ScopeMessagesReadContext}
	result, err := service.GetContext(context.Background(), value, "conv_direct", nil)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(result["messages"])
	if strings.Contains(string(encoded), "fileName") || strings.Contains(string(encoded), "storageKey") {
		t.Fatal("file metadata escaped scope")
	}
	repo.auth.Scopes = append(repo.auth.Scopes, ScopeFilesReadMetadata)
	result, err = service.GetContext(context.Background(), value, "conv_direct", nil)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ = json.Marshal(result["messages"])
	if !strings.Contains(string(encoded), "fileName") || strings.Contains(string(encoded), "storageKey") {
		t.Fatal("metadata projection must retain safe fields only")
	}
}
