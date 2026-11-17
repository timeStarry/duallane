package messages

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

func (t *fakeTx) UpdateAgentMessage(_ context.Context, input AgentMessageEditMutation) (bool, error) {
	record := t.repo.messages[input.MessageID]
	if record == nil || record.SpaceID != input.SpaceID || record.ConversationID != input.ConversationID ||
		record.AuthorID == nil || *record.AuthorID != input.ActorID || record.TopicID != "" || record.ThreadRootID != "" ||
		record.DeletedAt != nil || record.RecalledAt != nil {
		return false, nil
	}
	if !agentEditVersionEqual(input.ExpectedVersion, AgentMessageRecordVersion(*record)) ||
		!bytes.Equal(record.ContentJSON, input.ExpectedContentJSON) || record.PlainText != input.ExpectedPlainText {
		return false, nil
	}
	record.ContentJSON = append([]byte(nil), input.ContentJSON...)
	record.PlainText = input.PlainText
	record.EditedAt = timePointer(input.EditedAt)
	t.repo.messageFiles[input.MessageID] = append([]string(nil), input.AttachmentIDs...)
	t.repo.customEmoteIDs[input.MessageID] = append([]string(nil), input.CustomEmoteIDs...)
	t.repo.shareIDs[input.MessageID] = append([]string(nil), input.EmoteCollectionShareIDs...)
	return true, nil
}

var _ AgentMessageEditTx = (*fakeTx)(nil)

func agentEditTestService() (*Service, *fakeRepo, *MessageRecord) {
	repo := newFakeRepo()
	now := time.Date(2026, 11, 17, 10, 20, 30, 0, time.UTC)
	repo.actors["bot-edit"] = &auth.Actor{ID: "bot-edit", DisplayName: "Edit Bot", Kind: "bot", Role: "member"}
	repo.actors["usr-alice"] = &auth.Actor{ID: "usr-alice", DisplayName: "Alice", Nickname: "Alice", Kind: "human", Role: "member"}
	repo.actors["bot-other"] = &auth.Actor{ID: "bot-other", DisplayName: "Other Bot", Kind: "bot", Role: "member"}
	repo.conversations["conv-agent-edit"] = &ConversationRecord{ID: "conv-agent-edit", SpaceID: DefaultSpaceID, Type: "direct", RetentionCount: 10000}
	repo.members["conv-agent-edit"] = map[string]bool{"bot-edit": true, "bot-other": true, "usr-alice": true}
	repo.mentions["conv-agent-edit"] = map[string]*MentionMember{
		"usr-alice": {ID: "usr-alice", DisplayName: "Alice", Nickname: "Alice", Kind: "human"},
	}
	for _, id := range []string{"attachment-old", "attachment-new"} {
		conversationID := "conv-agent-edit"
		repo.attachments[id] = &AttachmentRecord{
			ID: id, SpaceID: DefaultSpaceID, UploaderID: "bot-edit", ConversationID: &conversationID,
			Visibility: "conversation", Status: "available", FileName: id + ".txt", MIMEType: "text/plain", ByteSize: 12,
			CreatedAt: now,
		}
	}
	oldContent := Content{Format: MessageContentFormat, Blocks: []Block{
		{Type: "text", Text: "原始内容"},
		{Type: "attachment", AttachmentID: "attachment-old"},
	}}
	oldJSON, _ := canonicalContent(oldContent)
	authorID := "bot-edit"
	target := &MessageRecord{
		ID: "message-agent-edit", SpaceID: DefaultSpaceID, ConversationID: "conv-agent-edit", AuthorID: &authorID,
		AuthorName: "Edit Bot", AuthorKind: "bot", Kind: "bot", ContentJSON: oldJSON, PlainText: ProjectPlainText(oldContent.Blocks),
		CreatedAt: now.Add(-time.Minute), Revision: 1,
	}
	repo.messages[target.ID] = target
	repo.messageFiles[target.ID] = []string{"attachment-old"}
	service := NewService(ServiceOptions{
		Repository: repo, SpaceID: DefaultSpaceID, AllowBots: true,
		Now:       func() time.Time { return now },
		IDFactory: func() (string, error) { return "agent-edit-event", nil },
	})
	return service, repo, target
}

func TestAgentMessageVersionBindsAuthorContentAndPlainText(t *testing.T) {
	content := []byte(`{"format":"duallane.message+json;v=1","blocks":[{"type":"text","text":"hello"}]}`)
	got := AgentMessageVersion("bot-edit", content, "hello")
	data, err := json.Marshal([]any{"bot-edit", json.RawMessage(content), "hello"})
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	want := hex.EncodeToString(sum[:])
	if got != want {
		t.Fatalf("version = %q, want %q", got, want)
	}
	for _, mutate := range []struct {
		name      string
		authorID  string
		content   []byte
		plainText string
	}{
		{name: "author", authorID: "other-bot", content: content, plainText: "hello"},
		{name: "content", authorID: "bot-edit", content: []byte(`{"format":"duallane.message+json;v=1","blocks":[{"type":"text","text":"changed"}]}`), plainText: "hello"},
		{name: "plain text", authorID: "bot-edit", content: content, plainText: "changed"},
	} {
		t.Run(mutate.name, func(t *testing.T) {
			if candidate := AgentMessageVersion(mutate.authorID, mutate.content, mutate.plainText); candidate == got {
				t.Fatalf("mutation kept version %q", candidate)
			}
		})
	}
	if AgentMessageVersion("", content, "hello") != "" || AgentMessageVersion("bot-edit", []byte("not-json"), "hello") != "" {
		t.Fatal("invalid identity/content unexpectedly produced a version")
	}
}

func TestEditAgentMessageInTxReplacesStructuredContentAndEvidence(t *testing.T) {
	service, repo, target := agentEditTestService()
	originalJSON := append([]byte(nil), target.ContentJSON...)
	inputContent := Content{
		Format:    MessageContentFormat,
		PlainText: "client text is ignored",
		Blocks: []Block{
			{Type: "text", Text: "更新后的内容"},
			{Type: "mention", UserID: "usr-alice", Label: "forged label"},
			{Type: "attachment", AttachmentID: "attachment-new"},
		},
	}
	var edited Message
	err := repo.WithTx(context.Background(), func(tx Tx) error {
		var editErr error
		edited, editErr = service.EditAgentMessageInTx(context.Background(), tx, AgentEditInput{
			ActorID: "bot-edit", ConversationID: target.ConversationID, MessageID: target.ID,
			ExpectedVersion: AgentMessageRecordVersion(*target), Content: inputContent,
			Meta: auth.RequestMeta{RequestID: "req-agent-edit"},
		})
		return editErr
	})
	if err != nil {
		t.Fatalf("EditAgentMessageInTx: %v", err)
	}
	if edited.ID != target.ID || edited.AuthorKind != "bot" || edited.PlainText != "更新后的内容@Alice[文件]" {
		t.Fatalf("edited projection = %#v", edited)
	}
	if edited.EditedAt == nil || *edited.EditedAt != "2026-11-17T10:20:30.000Z" {
		t.Fatalf("edited timestamp = %#v", edited.EditedAt)
	}
	updated := repo.messages[target.ID]
	if updated.PlainText != "更新后的内容@Alice[文件]" || string(updated.ContentJSON) == string(originalJSON) {
		t.Fatalf("stored edit = %#v", updated)
	}
	if got := strings.Join(repo.messageFiles[target.ID], ","); got != "attachment-new" {
		t.Fatalf("attachment relation = %q", got)
	}
	if len(repo.events) != 1 || repo.events[0].Type != "message.edited" || repo.events[0].TargetID != target.ID {
		t.Fatalf("edit events = %#v", repo.events)
	}
	if len(repo.audits) != 1 || repo.audits[0].Action != "message.edit" || repo.audits[0].Result != "success" {
		t.Fatalf("edit audits = %#v", repo.audits)
	}
}

func TestEditAgentMessageInTxRejectsStaleAndImplicitStructureLoss(t *testing.T) {
	tests := []struct {
		name     string
		content  Content
		expected string
		code     string
	}{
		{
			name:     "stale version",
			content:  Content{Format: MessageContentFormat, Blocks: []Block{{Type: "text", Text: "new"}, {Type: "attachment", AttachmentID: "attachment-old"}}},
			expected: "stale-version", code: CodeMessageRevisionConflict,
		},
		{
			name:    "text shortcut would drop attachment",
			content: Content{Format: MessageContentFormat, Blocks: []Block{{Type: "text", Text: "new"}}},
			code:    CodeMessageInvalidContent,
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			service, repo, target := agentEditTestService()
			expected := testCase.expected
			if expected == "" {
				expected = AgentMessageRecordVersion(*target)
			}
			err := repo.WithTx(context.Background(), func(tx Tx) error {
				_, editErr := service.EditAgentMessageInTx(context.Background(), tx, AgentEditInput{
					ActorID: "bot-edit", ConversationID: target.ConversationID, MessageID: target.ID,
					ExpectedVersion: expected, Content: testCase.content,
				})
				return editErr
			})
			if !isMessageCode(err, testCase.code) {
				t.Fatalf("error = %v, want %s", err, testCase.code)
			}
			if len(repo.events) != 0 || len(repo.audits) != 0 || repo.messages[target.ID].EditedAt != nil {
				t.Fatalf("rejected edit left evidence/state: events=%d audits=%d record=%#v", len(repo.events), len(repo.audits), repo.messages[target.ID])
			}
		})
	}
}

func TestEditAgentMessageInTxRejectsNonBotOtherAuthorAndThread(t *testing.T) {
	tests := []struct {
		name    string
		actorID string
		mutate  func(*MessageRecord)
		code    string
	}{
		{name: "human actor", actorID: "usr-alice", code: CodePermissionDenied},
		{name: "other Bot author", actorID: "bot-other", code: CodePermissionDenied},
		{name: "topic message", actorID: "bot-edit", mutate: func(record *MessageRecord) { record.TopicID = "topic-1" }, code: CodeMessageInvalid},
		{name: "thread message", actorID: "bot-edit", mutate: func(record *MessageRecord) { record.ThreadRootID = "message-root" }, code: CodeMessageInvalid},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			service, repo, target := agentEditTestService()
			if testCase.mutate != nil {
				testCase.mutate(target)
			}
			if testCase.actorID == "usr-alice" {
				// The human is already a conversation member in the fixture.
			} else if testCase.actorID == "bot-other" {
				// The second Bot is also a member; the author check must reject it.
			}
			err := repo.WithTx(context.Background(), func(tx Tx) error {
				_, editErr := service.EditAgentMessageInTx(context.Background(), tx, AgentEditInput{
					ActorID: testCase.actorID, ConversationID: target.ConversationID, MessageID: target.ID,
					ExpectedVersion: AgentMessageRecordVersion(*target),
					Content:         Content{Format: MessageContentFormat, Blocks: []Block{{Type: "text", Text: "updated"}, {Type: "attachment", AttachmentID: "attachment-old"}}},
				})
				return editErr
			})
			if !isMessageCode(err, testCase.code) {
				t.Fatalf("error = %v, want %s", err, testCase.code)
			}
		})
	}
}

func TestEditAgentMessageInTxRequiresOptionalConditionalWriter(t *testing.T) {
	service, repo, target := agentEditTestService()
	// A Tx that has the legacy surface but no Agent edit extension must fail
	// closed; the gateway cannot accidentally fall back to a raw update.
	type legacyTx struct{ Tx }
	err := repo.WithTx(context.Background(), func(tx Tx) error {
		_, editErr := service.EditAgentMessageInTx(context.Background(), legacyTx{Tx: tx}, AgentEditInput{
			ActorID: "bot-edit", ConversationID: target.ConversationID, MessageID: target.ID,
			ExpectedVersion: AgentMessageRecordVersion(*target),
			Content:         Content{Format: MessageContentFormat, Blocks: []Block{{Type: "text", Text: "updated"}, {Type: "attachment", AttachmentID: "attachment-old"}}},
		})
		return editErr
	})
	if !isMessageCode(err, CodeInternal) {
		t.Fatalf("missing optional writer error = %v", err)
	}
}
