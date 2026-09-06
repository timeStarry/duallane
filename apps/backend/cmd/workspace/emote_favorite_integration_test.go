//go:build postgres_integration

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/emotes"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/files"
)

// Reuse the enabled application's real PostgreSQL, media and local storage
// fixture. Only the source message is seeded; file transfer and favorite go
// through the authenticated HTTP surface and the actual composition adapter.
func assertEmoteFavoriteHTTPComposition(t *testing.T, ctx context.Context, app *application, request func(string, string, string, []byte) *httptest.ResponseRecorder) {
	t.Helper()
	var source bytes.Buffer
	if err := png.Encode(&source, image.NewNRGBA(image.Rect(0, 0, 3, 3))); err != nil {
		t.Fatal(err)
	}
	pngBytes := source.Bytes()
	const conversation, message = "composition-favorite-conversation", "composition-favorite-message"
	for _, query := range []string{
		`INSERT INTO conversations (id,space_id,type,title,created_by,created_at) VALUES ('composition-favorite-conversation','spc_default','group','Fixture','composition-user',NOW())`,
		`INSERT INTO conversation_members (conversation_id,user_id,joined_at) VALUES ('composition-favorite-conversation','composition-user',NOW())`,
		`INSERT INTO messages (id,space_id,conversation_id,author_id,author_kind,kind,client_message_id,content_format,content_json,plain_text,created_at) VALUES ('composition-favorite-message','spc_default','composition-favorite-conversation','composition-user','human','user','favorite-client','duallane.message+json;v=1','{"blocks":[]}','',NOW())`,
	} {
		if _, err := app.pool.Exec(ctx, query); err != nil {
			t.Fatal(err)
		}
	}
	reserve := request(http.MethodPost, "/api/workspace/files/uploads/reserve", "application/json", []byte(fmt.Sprintf(`{"fileName":"favorite.png","mimeType":"image/png","byteSize":%d,"visibility":"conversation","conversationId":%q}`, len(pngBytes), conversation)))
	var reserved files.UploadResult
	if reserve.Code != http.StatusCreated || json.Unmarshal(reserve.Body.Bytes(), &reserved) != nil || reserved.Upload == nil || reserved.Attachment == nil {
		t.Fatalf("favorite source reserve status=%d", reserve.Code)
	}
	upload := request(http.MethodPut, "/api/workspace/files/uploads/"+reserved.Upload.ID+"/content", "application/octet-stream", pngBytes)
	if upload.Code != http.StatusOK {
		t.Fatalf("favorite source upload status=%d", upload.Code)
	}
	if _, err := app.pool.Exec(ctx, `INSERT INTO message_attachments (message_id,attachment_id) VALUES ($1,$2)`, message, reserved.Attachment.ID); err != nil {
		t.Fatal(err)
	}
	var before int
	if err := app.pool.QueryRow(ctx, `SELECT COUNT(*) FROM transfer_ledger WHERE direction='download'`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	favorite := request(http.MethodPost, "/api/workspace/me/emotes/favorite", "application/json", []byte(fmt.Sprintf(`{"messageId":%q,"attachmentId":%q}`, message, reserved.Attachment.ID)))
	var result struct {
		Emote emotes.CustomEmote `json:"emote"`
	}
	if favorite.Code != http.StatusCreated || json.Unmarshal(favorite.Body.Bytes(), &result) != nil || result.Emote.ID == "" || result.Emote.SourceType != "attachment" {
		t.Fatalf("favorite source HTTP status=%d body=%s", favorite.Code, favorite.Body.String())
	}
	content := request(http.MethodGet, "/api/workspace/emotes/"+result.Emote.ID+"/content", "", nil)
	if content.Code != http.StatusOK || content.Header().Get("Content-Type") != "image/webp" || !bytes.HasPrefix(content.Body.Bytes(), []byte("RIFF")) {
		t.Fatalf("favorite processed content status=%d", content.Code)
	}
	var after int
	if err := app.pool.QueryRow(ctx, `SELECT COUNT(*) FROM transfer_ledger WHERE direction='download'`).Scan(&after); err != nil || after != before {
		t.Fatalf("favorite changed download ledger: %d -> %d (%v)", before, after, err)
	}
	// A still-existing attachment cannot bypass the message visibility gate.
	if _, err := app.pool.Exec(ctx, `UPDATE conversation_members SET removed_at=NOW() WHERE conversation_id=$1 AND user_id='composition-user'`, conversation); err != nil {
		t.Fatal(err)
	}
	denied := request(http.MethodPost, "/api/workspace/me/emotes/favorite", "application/json", []byte(fmt.Sprintf(`{"messageId":%q,"attachmentId":%q}`, message, reserved.Attachment.ID)))
	if denied.Code != http.StatusNotFound || !bytes.Contains(denied.Body.Bytes(), []byte("message.not_found")) {
		t.Fatalf("favorite after revoked visibility status=%d", denied.Code)
	}
}
