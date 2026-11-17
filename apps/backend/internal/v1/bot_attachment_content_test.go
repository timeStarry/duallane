package v1

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/botgateway"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/files"
)

type attachmentAuthStub struct {
	input       botgateway.AttachmentReadInput
	denied      bool
	noFileScope bool
}

func (a *attachmentAuthStub) Authenticate(context.Context, string, botgateway.TokenAuthOptions) (*botgateway.Auth, error) {
	scopes := []string{botgateway.ScopeFilesWrite}
	if a.noFileScope {
		scopes = nil
	}
	return &botgateway.Auth{BotID: "bot_comet", UserID: "usr_bot_comet", SpaceID: "spc_default", Scopes: scopes}, nil
}
func (a *attachmentAuthStub) AuthorizeAttachmentRead(_ context.Context, _ *botgateway.Auth, input botgateway.AttachmentReadInput) (botgateway.Attachment, error) {
	a.input = input
	if a.denied {
		return botgateway.Attachment{}, botgateway.NewError(botgateway.CodeContextForbidden, "denied", 403)
	}
	return botgateway.Attachment{ID: input.AttachmentID, FileName: "input.txt", MIMEType: "text/plain", ByteSize: 5}, nil
}

type attachmentReaderStub struct {
	stubBotFiles
	reads       int
	input       files.OpenAttachmentInput
	statusReads int
}

func (r *attachmentReaderStub) GetAgentBotUploadStatus(_ context.Context, input files.UploadStatusInput) (files.UploadStatus, error) {
	r.statusReads++
	if input.ActorID != "usr_bot_comet" || input.UploadID != "upload_1" {
		return files.UploadStatus{}, files.NewError(files.CodeUploadInvalid, files.MessageUploadInvalid, 404)
	}
	return files.UploadStatus{Status: "completed", UploadID: input.UploadID, Attachment: &files.Attachment{ID: "att_1", Status: "available"}}, nil
}

func (r *attachmentReaderStub) OpenAgentBotAttachmentContent(_ context.Context, input files.OpenAttachmentInput) (platformstorage.OpenedObject, error) {
	r.reads++
	r.input = input
	return platformstorage.OpenedObject{Object: platformstorage.Object{ByteSize: 5}, Body: io.NopCloser(strings.NewReader("hello"))}, nil
}

func TestBotUploadStatusRecoversReceiptWithFileScope(t *testing.T) {
	authorizer := &attachmentAuthStub{}
	reader := &attachmentReaderStub{}
	r := chi.NewRouter()
	NewHTTPHandler(NewService(&stubRepo{}), nil).WithBotAuthenticator(authorizer).WithBotFilePipeline(reader, nil).Mount(r)
	request := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/api/bot/v2/uploads/upload_1", nil)
		req.Header.Set("Authorization", "Bearer dl_bot_synthetic_012345678901234567890123456789")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}
	rec := request()
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"uploadId":"upload_1"`) || !strings.Contains(rec.Body.String(), `"attachment":{"id":"att_1"`) || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status: %d %s", rec.Code, rec.Body)
	}
	authorizer.noFileScope = true
	if rec := request(); rec.Code != 403 || reader.statusReads != 1 {
		t.Fatal("upload status bypassed files:write")
	}
}
func TestBotAttachmentContentUsesAuthorizedLogicalReader(t *testing.T) {
	authorizer := &attachmentAuthStub{}
	reader := &attachmentReaderStub{}
	r := chi.NewRouter()
	NewHTTPHandler(NewService(&stubRepo{}), nil).WithBotAuthenticator(authorizer).WithBotFilePipeline(reader, nil).Mount(r)
	request := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/api/bot/v2/conversations/conv_1/attachments/att_1/content?messageId=msg_1&mode=preview", nil)
		req.Header.Set("Authorization", "Bearer dl_bot_synthetic_012345678901234567890123456789")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}
	rec := request()
	if rec.Code != http.StatusOK || rec.Body.String() != "hello" || rec.Header().Get("Cache-Control") != "no-store" || rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("content response: %d %s", rec.Code, rec.Body)
	}
	if authorizer.input.MessageID != "msg_1" || authorizer.input.ConversationID != "conv_1" || reader.input.AttachmentID != "att_1" || reader.input.MaxBytes != botgateway.MaxAgentAttachmentPreviewBytes {
		t.Fatal("source/limit not bound")
	}
	authorizer.denied = true
	rec = request()
	if rec.Code != 403 || reader.reads != 1 {
		t.Fatal("authorization denial reached object reader")
	}
}
