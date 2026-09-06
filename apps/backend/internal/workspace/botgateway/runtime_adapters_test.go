package botgateway

import (
	"context"
	"errors"
	"testing"

	workspaceauth "github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	workspacecards "github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	workspacefiles "github.com/timestarry/duallane/apps/backend/internal/workspace/files"
	workspacemessages "github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

type recordingAgentBotUploader struct {
	calls  int
	input  workspacefiles.ReserveUploadInput
	result workspacefiles.UploadResult
}

func (f *recordingAgentBotUploader) ReserveAgentBotUpload(_ context.Context, input workspacefiles.ReserveUploadInput) (workspacefiles.UploadResult, error) {
	f.calls++
	f.input = input
	return f.result, nil
}

func TestAttachmentWriterUsesNarrowAgentBotReservation(t *testing.T) {
	fake := &recordingAgentBotUploader{result: workspacefiles.UploadResult{Status: string(workspacefiles.TransferReserved), ID: "upload-1"}}
	writer := &attachmentWriter{service: fake}
	meta := workspaceauth.RequestMeta{RequestID: "request-1", IPAddress: "127.0.0.1", UserAgent: "bot-test"}

	result, err := writer.ReserveAttachment(context.Background(), AttachmentCreateRequest{
		ActorID: "bot-user", SpaceID: "space-1", ConversationID: "conversation-1", FileName: "draft.txt",
		MIMEType: "text/plain", ByteSize: 12, Visibility: "private_staging", Meta: meta,
	})
	if err != nil {
		t.Fatal(err)
	}
	if fake.calls != 1 {
		t.Fatalf("ReserveAgentBotUpload calls = %d, want 1", fake.calls)
	}
	if fake.input.ActorID != "bot-user" || fake.input.ConversationID != "conversation-1" || fake.input.ByteSize != 12 || fake.input.Meta.RequestID != meta.RequestID {
		t.Fatalf("reservation input = %#v", fake.input)
	}
	if result.Status != string(workspacefiles.TransferReserved) || result.ID != "upload-1" {
		t.Fatalf("reservation result = %#v", result)
	}
}

func TestRuntimeAdaptersProjectSafeMessage(t *testing.T) {
	authorID := "bot-user"
	message := projectWorkspaceMessage(workspacemessages.Message{
		ID: "message-1", ConversationID: "conversation-1", AuthorID: &authorID, AuthorName: "Gateway Bot",
		AuthorNickname: "Bot", AuthorKind: "bot", PlainText: "hello", CreatedAt: "2026-09-06T00:00:00.000Z",
		Content: workspacemessages.Content{
			Format: workspacemessages.MessageContentFormat, PlainText: "hello",
			Blocks: []workspacemessages.Block{{Type: "text", Text: "hello"}},
		},
	})
	if message.Author.(map[string]any)["id"] != authorID {
		t.Fatalf("author projection = %#v", message.Author)
	}
	if message.Content["format"] != workspacemessages.MessageContentFormat || message.Content["plainText"] != "hello" {
		t.Fatalf("content projection = %#v", message.Content)
	}
	if _, leaked := message.Content["authorId"]; leaked {
		t.Fatal("message content included unrelated fields")
	}
}

func TestRuntimeAdaptersMapDomainErrorsWithoutCauses(t *testing.T) {
	cause := errors.New("driver detail must not cross gateway")
	got := normalizeRuntimeAdapterError(&workspacecards.Error{Code: workspacecards.CodeCardNotFound, Message: "safe card error", StatusCode: 404, Cause: cause}, "card operation")
	var gatewayErr *Error
	if !errors.As(got, &gatewayErr) {
		t.Fatalf("mapped error = %T %v", got, got)
	}
	if gatewayErr.Code != workspacecards.CodeCardNotFound || gatewayErr.Message != "safe card error" || gatewayErr.StatusCode != 404 {
		t.Fatalf("mapped error = %#v", gatewayErr)
	}
	if gatewayErr.Error() != workspacecards.CodeCardNotFound || gatewayErr.Public().Cause != nil {
		t.Fatalf("mapped error leaked cause = %#v", gatewayErr)
	}
}

func TestRuntimeAdaptersCardBlockProjection(t *testing.T) {
	block := cardBlockMap(workspacecards.CardBlock{Type: workspacecards.CardBlockType, CardID: "card-1", CardType: "poll", SchemaVersion: 1, FallbackText: "fallback"})
	if block["type"] != workspacecards.CardBlockType || block["cardId"] != "card-1" || block["schemaVersion"] != 1 {
		t.Fatalf("card block = %#v", block)
	}
	if _, ok := block["payload"]; ok {
		t.Fatal("card block projected private payload")
	}
}
