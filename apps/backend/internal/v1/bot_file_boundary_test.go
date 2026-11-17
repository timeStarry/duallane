package v1

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/botgateway"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/files"
	sdkgate "github.com/timestarry/duallane/apps/backend/internal/workspace/sdkgate"
)

type unreadBotBody struct{ reads int }

func (b *unreadBotBody) Read([]byte) (int, error) {
	b.reads++
	return 0, errors.New("must not read rejected body")
}
func (*unreadBotBody) Close() error { return nil }

func botFileBoundaryRouter(scopes []string, uploader *stubBotFiles) http.Handler {
	h := NewHTTPHandler(NewService(&stubRepo{}), nil).
		WithBotAuthenticator(botAuthFunc(func(context.Context, string, botgateway.TokenAuthOptions) (*botgateway.Auth, error) {
			return &botgateway.Auth{BotID: "bot_comet", UserID: "usr_bot_comet", SpaceID: "spc_default", Scopes: scopes}, nil
		})).WithBotFilePipeline(uploader, &stubBotMessageCreator{})
	r := chi.NewRouter()
	h.Mount(r)
	return r
}

func TestBotFileAdmissionRejectsBeforeReadingBody(t *testing.T) {
	for _, tc := range []struct {
		name, method, path string
		scopes             []string
		length             int64
		reserveErr         error
		status             int
	}{
		{"send-does-not-grant-files", "POST", "/api/bot/v2/conversations/conv_dm_bot_1/files", []string{botgateway.ScopeMessagesSend}, 5, nil, 403},
		{"complete-does-not-grant-files", "PUT", "/api/bot/v2/uploads/upload_1/content", []string{botgateway.ScopeMessagesSend}, 5, nil, 403},
		{"files-do-not-grant-send", "POST", "/api/bot/v2/conversations/conv_dm_bot_1/files", []string{botgateway.ScopeFilesWrite}, 5, nil, 403},
		{"unknown-length", "POST", "/api/bot/v2/conversations/conv_dm_bot_1/files?sendMessage=false", []string{botgateway.ScopeFilesWrite}, -1, nil, 411},
		{"oversized", "POST", "/api/bot/v2/conversations/conv_dm_bot_1/files?sendMessage=false", []string{botgateway.ScopeFilesWrite}, MaxBotFileUploadBytes + 1, nil, 413},
		{"quota", "POST", "/api/bot/v2/conversations/conv_dm_bot_1/files?sendMessage=false", []string{botgateway.ScopeFilesWrite}, 5, files.NewError(files.CodeQuotaInsufficient, files.MessageQuotaInsufficient, 429), 429},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := &unreadBotBody{}
			uploader := &stubBotFiles{reserveError: tc.reserveErr}
			req := httptest.NewRequest(tc.method, tc.path, nil)
			req.Body = body
			req.ContentLength = tc.length
			req.Header.Set("Authorization", "Bearer dl_bot_synthetic_012345678901234567890123456789")
			req.Header.Set(sdkgate.SDKVersionHeader, sdkgate.MinimumSDKVersion)
			rec := httptest.NewRecorder()
			botFileBoundaryRouter(tc.scopes, uploader).ServeHTTP(rec, req)
			if rec.Code != tc.status || body.reads != 0 {
				t.Fatalf("status=%d reads=%d body=%s", rec.Code, body.reads, rec.Body)
			}
		})
	}
}

func TestBotFileUploadOnlyAndFailureCleanup(t *testing.T) {
	uploader := &stubBotFiles{}
	router := botFileBoundaryRouter([]string{botgateway.ScopeFilesWrite}, uploader)
	req := httptest.NewRequest("POST", "/api/bot/v2/conversations/conv_dm_bot_1/files?sendMessage=false&fileName=a.txt", strings.NewReader("hello"))
	req.Header.Set("Authorization", "Bearer dl_bot_synthetic_012345678901234567890123456789")
	req.Header.Set(sdkgate.SDKVersionHeader, sdkgate.MinimumSDKVersion)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != 201 || string(uploader.completedBytes) != "hello" || uploader.reservedInput.ByteSize != 5 {
		t.Fatalf("upload-only: %d %s", rec.Code, rec.Body)
	}
	uploader.completeError = files.NewError(files.CodeUploadSizeMismatch, files.MessageUploadSizeMismatch, 400)
	req = httptest.NewRequest("POST", "/api/bot/v2/conversations/conv_dm_bot_1/files?sendMessage=false", io.NopCloser(strings.NewReader("short")))
	req.ContentLength = 9
	req.Header.Set("Authorization", "Bearer dl_bot_synthetic_012345678901234567890123456789")
	req.Header.Set(sdkgate.SDKVersionHeader, sdkgate.MinimumSDKVersion)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != 400 || uploader.failedUploadID != "upl_bot_test_1" {
		t.Fatalf("reservation not released: %d %s", rec.Code, rec.Body)
	}
}
