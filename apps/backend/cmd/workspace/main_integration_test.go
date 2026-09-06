//go:build postgres_integration

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5"
	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	"github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/emotes"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/presence"
)

func TestEnabledApplicationServesEmotesWithRealMediaAndStorage(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	schema := fmt.Sprintf("duallane_composition_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := conn.Exec(cleanupCtx, "DROP SCHEMA "+identifier+" CASCADE"); err != nil {
			t.Error(err)
		}
	}()
	if _, err := conn.Exec(ctx, "SET search_path TO "+identifier); err != nil {
		t.Fatal(err)
	}
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	webDir := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../web"))
	if _, err := (migrations.Runner{Beginner: postgres.NewMigrationBeginner(conn), Directory: filepath.Join(webDir, "server/migrations")}).Run(ctx); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		`INSERT INTO users (id,github_login,display_name,kind,created_at,last_login_at) VALUES ('composition-user','composition-user','Fixture','human',NOW(),NOW())`,
		`INSERT INTO spaces (id,name,slug,created_by,created_at) VALUES ('spc_default','Fixture','fixture','composition-user',NOW())`,
		`INSERT INTO space_members (space_id,user_id,role,joined_at) VALUES ('spc_default','composition-user','owner',NOW())`,
	} {
		if _, err := conn.Exec(ctx, query); err != nil {
			t.Fatal(err)
		}
	}
	isolatedDSN, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	query := isolatedDSN.Query()
	query.Set("search_path", schema)
	isolatedDSN.RawQuery = query.Encode()
	t.Setenv("DATABASE_URL", isolatedDSN.String())
	app, err := newApplication(ctx, config.WorkspaceConfig{
		Enabled: true, Environment: "test", AppVersion: "test", StorageDriver: "local", DataDir: t.TempDir(),
		EmoteCatalogPath: filepath.Join(webDir, "shared/emote-packs.json"), GitHubOAuthTimeout: time.Second,
		MigrationsDir: filepath.Join(webDir, "server/migrations"),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	session, err := auth.NewService(auth.ServiceOptions{Store: auth.NewPGStore(app.pool)}).CreateSession(ctx, "composition-user")
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, path, contentType string, body []byte) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, bytes.NewReader(body))
		r.AddCookie(&http.Cookie{Name: auth.SessionCookieName, Value: session.Token})
		r.Header.Set("Content-Type", contentType)
		r.Header.Set("X-DualLane-File-Name", "fixture.png")
		w := httptest.NewRecorder()
		app.handler.ServeHTTP(w, r)
		return w
	}
	t.Run("Echo HTTP uses the real authorized domain repositories", func(t *testing.T) {
		assertEchoHTTPComposition(t, ctx, app, request)
	})
	settings := request(http.MethodGet, "/api/workspace/me/emote-settings", "", nil)
	var settingsBody struct {
		Settings emotes.EmoteSettings `json:"settings"`
	}
	if settings.Code != http.StatusOK || json.Unmarshal(settings.Body.Bytes(), &settingsBody) != nil || len(settingsBody.Settings.AvailablePacks) == 0 || len(settingsBody.Settings.EnabledPackIDs) == 0 {
		t.Fatalf("settings=%d %s", settings.Code, settings.Body.String())
	}
	var input bytes.Buffer
	if err := png.Encode(&input, image.NewNRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	avatarUpload := request(http.MethodPut, "/api/workspace/me/avatar", "image/png", input.Bytes())
	var avatarBody struct {
		User struct {
			AvatarURL string `json:"avatarUrl"`
		} `json:"user"`
	}
	if avatarUpload.Code != http.StatusOK || json.Unmarshal(avatarUpload.Body.Bytes(), &avatarBody) != nil || avatarBody.User.AvatarURL == "" {
		t.Fatalf("avatar upload=%d %s", avatarUpload.Code, avatarUpload.Body.String())
	}
	avatar := request(http.MethodGet, avatarBody.User.AvatarURL, "", nil)
	if avatar.Code != http.StatusOK || avatar.Header().Get("Content-Type") != "image/webp" || !bytes.HasPrefix(avatar.Body.Bytes(), []byte("RIFF")) {
		t.Fatalf("avatar delivery=%d type=%q", avatar.Code, avatar.Header().Get("Content-Type"))
	}
	removedAvatar := request(http.MethodDelete, "/api/workspace/me/avatar", "", nil)
	if removedAvatar.Code != http.StatusOK {
		t.Fatalf("avatar remove=%d %s", removedAvatar.Code, removedAvatar.Body.String())
	}
	if stale := request(http.MethodGet, avatarBody.User.AvatarURL, "", nil); stale.Code != http.StatusNotFound {
		t.Fatalf("removed avatar still visible: %d", stale.Code)
	}
	var avatarAudits int
	if err := app.pool.QueryRow(ctx, `SELECT COUNT(*) FROM audit_logs WHERE actor_user_id='composition-user' AND action IN ('profile.avatar_update','profile.avatar_remove') AND result='success'`).Scan(&avatarAudits); err != nil || avatarAudits != 2 {
		t.Fatalf("avatar audit count=%d err=%v", avatarAudits, err)
	}
	upload := request(http.MethodPost, "/api/workspace/me/emotes", "image/png", input.Bytes())
	var uploadBody struct {
		Emote emotes.CustomEmote `json:"emote"`
	}
	if upload.Code != http.StatusCreated || json.Unmarshal(upload.Body.Bytes(), &uploadBody) != nil || uploadBody.Emote.ID == "" {
		t.Fatalf("upload=%d %s", upload.Code, upload.Body.String())
	}
	delivery := request(http.MethodGet, "/api/workspace/emotes/"+uploadBody.Emote.ID+"/content", "", nil)
	if delivery.Code != http.StatusOK || delivery.Header().Get("Content-Type") != "image/webp" || !bytes.HasPrefix(delivery.Body.Bytes(), []byte("RIFF")) {
		t.Fatalf("delivery=%d type=%q", delivery.Code, delivery.Header().Get("Content-Type"))
	}
	var count int
	if err := app.pool.QueryRow(ctx, `SELECT COUNT(*) FROM audit_logs WHERE actor_user_id='composition-user' AND action='emote.create' AND result='success'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("upload audit count=%d err=%v", count, err)
	}
	overage := httptest.NewRequest(http.MethodPost, "/api/workspace/me/emotes", nil)
	overage.AddCookie(&http.Cookie{Name: auth.SessionCookieName, Value: session.Token})
	overage.ContentLength = emotes.MaxInputBytes + 1
	unread := &forbiddenUploadBody{t: t}
	overage.Body = unread
	rejected := httptest.NewRecorder()
	app.handler.ServeHTTP(rejected, overage)
	if rejected.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("declared overage status = %d", rejected.Code)
	}
	if err := app.pool.QueryRow(ctx, `SELECT COUNT(*) FROM audit_logs WHERE actor_user_id='composition-user' AND action='emote.create' AND result='rejected' AND reason=$1`, emotes.CodeEmoteInputTooLarge).Scan(&count); err != nil || count != 1 {
		t.Fatalf("overage audit count=%d err=%v", count, err)
	}
	t.Run("realtime publishes shared presence and removes only its own lease", func(t *testing.T) {
		server := httptest.NewServer(app.handler)
		defer server.Close()
		lookup := presence.NewService(presence.ServiceOptions{Repository: presence.NewPGRepository(app.pool)})
		waitForCount := func(want int) {
			t.Helper()
			deadline := time.NewTimer(5 * time.Second)
			defer deadline.Stop()
			tick := time.NewTicker(10 * time.Millisecond)
			defer tick.Stop()
			for {
				var count int
				if err := app.pool.QueryRow(ctx, `SELECT COUNT(*) FROM workspace_presence_leases WHERE user_id='composition-user'`).Scan(&count); err != nil {
					t.Fatal(err)
				}
				if count == want {
					online, err := lookup.IsOnlineContext(ctx, "composition-user")
					if err != nil || online != (want > 0) {
						t.Fatalf("shared presence online=%v error=%v", online, err)
					}
					return
				}
				select {
				case <-deadline.C:
					t.Fatalf("presence lease count=%d want=%d", count, want)
				case <-tick.C:
				}
			}
		}
		dial := func() *websocket.Conn {
			t.Helper()
			connection, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/ws/workspace", &websocket.DialOptions{
				HTTPHeader: http.Header{"Cookie": {(&http.Cookie{Name: auth.SessionCookieName, Value: session.Token}).String()}},
			})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = connection.CloseNow() })
			if err := connection.Write(ctx, websocket.MessageText, []byte(`{"version":1,"type":"hello","lastSeq":0}`)); err != nil {
				t.Fatal(err)
			}
			readCtx, cancelRead := context.WithTimeout(ctx, 5*time.Second)
			defer cancelRead()
			_, raw, err := connection.Read(readCtx)
			var ready struct {
				Type string `json:"type"`
			}
			if err != nil || json.Unmarshal(raw, &ready) != nil || ready.Type != "ready" {
				t.Fatalf("realtime handshake type=%s error=%v", ready.Type, err)
			}
			return connection
		}
		first := dial()
		waitForCount(1)
		second := dial()
		waitForCount(2)
		_ = first.CloseNow()
		waitForCount(1)
		_ = second.CloseNow()
		waitForCount(0)
	})

	t.Run("inline topic message resolves the registered card", func(t *testing.T) {
		for _, query := range []string{
			`INSERT INTO conversations (id,space_id,type,title,retention_count,created_by,created_at) VALUES ('composition-group','spc_default','group','Fixture group',10000,'composition-user',NOW())`,
			`INSERT INTO conversation_members (conversation_id,user_id,joined_at) VALUES ('composition-group','composition-user',NOW())`,
		} {
			if _, err := conn.Exec(ctx, query); err != nil {
				t.Fatal(err)
			}
		}
		body := []byte(`{"conversationId":"composition-group","clientMessageId":"inline-fixture","content":{"format":"duallane.message+json;v=1","blocks":[{"type":"text","text":"#[Fixture topic](Fixture body)"}]}}`)
		var firstID string
		for attempt := 0; attempt < 2; attempt++ {
			created := request(http.MethodPost, "/api/workspace/messages", "application/json", body)
			var result struct {
				Message messages.Message `json:"message"`
			}
			if created.Code != http.StatusCreated || json.Unmarshal(created.Body.Bytes(), &result) != nil || result.Message.ClientMessageID == nil || *result.Message.ClientMessageID != "inline-fixture" || len(result.Message.Content.Blocks) != 2 {
				t.Fatalf("topic create=%d %s", created.Code, created.Body.String())
			}
			if attempt == 0 {
				firstID = result.Message.ID
			} else if result.Message.ID != firstID {
				t.Fatal("inline HTTP retry duplicated message")
			}
			cardID := result.Message.Content.Blocks[1].CardID
			resolved := request(http.MethodGet, "/api/workspace/cards/"+cardID, "", nil)
			var card struct {
				Card cards.Resolution `json:"card"`
			}
			if resolved.Code != http.StatusOK || json.Unmarshal(resolved.Body.Bytes(), &card) != nil || card.Card.Type != "card" || card.Card.Payload == nil {
				t.Fatalf("topic card=%d %s", resolved.Code, resolved.Body.String())
			}
		}
		for _, test := range []struct {
			key    string
			status int
		}{{"feishu:ok", http.StatusCreated}, {"qq:smile", http.StatusBadRequest}, {"forged:ok", http.StatusBadRequest}} {
			response := request(http.MethodPost, "/api/workspace/messages/"+firstID+"/reactions", "application/json", []byte(`{"emoteKey":"`+test.key+`"}`))
			if response.Code != test.status {
				t.Fatalf("composed reaction %s = %d %s", test.key, response.Code, response.Body.String())
			}
		}
		if removed := request(http.MethodDelete, "/api/workspace/messages/"+firstID+"/reactions/feishu:ok", "", nil); removed.Code != http.StatusOK {
			t.Fatalf("composed reaction removal = %d", removed.Code)
		}
	})

	// A missing migration must fail readiness and a fresh startup before any
	// object directory, session, seed or event-listener side effect is created.
	if ready := request(http.MethodGet, "/readyz", "", nil); ready.Code != http.StatusOK {
		t.Fatalf("initial readiness = %d", ready.Code)
	}
	if _, err := conn.Exec(ctx, `DELETE FROM schema_migrations WHERE name = (SELECT MAX(name) FROM schema_migrations)`); err != nil {
		t.Fatal(err)
	}
	if ready := request(http.MethodGet, "/readyz", "", nil); ready.Code != http.StatusServiceUnavailable {
		t.Fatalf("incompatible schema readiness = %d", ready.Code)
	}
	untouchedDataDir := filepath.Join(t.TempDir(), "must-not-create")
	refused, err := newApplication(ctx, config.WorkspaceConfig{
		Enabled: true, StorageDriver: "local", DataDir: untouchedDataDir,
		EmoteCatalogPath: filepath.Join(webDir, "shared/emote-packs.json"),
		MigrationsDir:    filepath.Join(webDir, "server/migrations"), GitHubOAuthTimeout: time.Second,
	})
	if refused != nil {
		refused.Close()
	}
	if !errors.Is(err, migrations.ErrMissingMigrations) || refused != nil {
		t.Fatalf("incompatible schema startup = %v, app present = %v", err, refused != nil)
	}
	if _, err := os.Stat(untouchedDataDir); !os.IsNotExist(err) {
		t.Fatalf("refused startup touched storage: %v", err)
	}

	t.Run("application shutdown joins durable bot gateway cleanup", func(t *testing.T) {
		created := request(http.MethodPost, "/api/workspace/bots", "application/json", []byte(`{"name":"Gateway Fixture"}`))
		var createdBody struct {
			Bot struct {
				ID        string `json:"id"`
				BotUserID string `json:"botUserId"`
			} `json:"bot"`
		}
		if created.Code != http.StatusCreated || json.Unmarshal(created.Body.Bytes(), &createdBody) != nil || createdBody.Bot.ID == "" {
			t.Fatalf("bot create status=%d", created.Code)
		}
		botID := createdBody.Bot.ID
		tokenResponse := request(http.MethodPost, "/api/workspace/bots/"+botID+"/tokens", "application/json", []byte(`{"scopes":["messages:read_trigger","messages:send","commands:receive","cards:write"]}`))
		var tokenBody struct {
			Token string `json:"token"`
		}
		if tokenResponse.Code != http.StatusCreated || json.Unmarshal(tokenResponse.Body.Bytes(), &tokenBody) != nil || tokenBody.Token == "" {
			t.Fatalf("token create status=%d", tokenResponse.Code)
		}
		directBody, err := json.Marshal(map[string]any{"type": "direct", "targetUserId": createdBody.Bot.BotUserID})
		if err != nil {
			t.Fatal(err)
		}
		direct := request(http.MethodPost, "/api/workspace/conversations", "application/json", directBody)
		var directResult struct {
			Conversation struct {
				ID string `json:"id"`
			} `json:"conversation"`
		}
		if direct.Code != http.StatusCreated || json.Unmarshal(direct.Body.Bytes(), &directResult) != nil || directResult.Conversation.ID == "" {
			t.Fatalf("bot direct create status=%d", direct.Code)
		}
		gatewayBody, err := json.Marshal(map[string]any{"conversationId": directResult.Conversation.ID, "clientMessageId": "gateway-main-fixture", "text": "#[Bot text](must remain ordinary)", "idempotencyKey": "gateway-main-fixture"})
		if err != nil {
			t.Fatal(err)
		}
		var firstID string
		for attempt := 0; attempt < 2; attempt++ {
			r := httptest.NewRequest(http.MethodPost, "/api/bot-gateway/v1/messages", bytes.NewReader(gatewayBody))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Authorization", "Bearer "+tokenBody.Token)
			response := httptest.NewRecorder()
			app.handler.ServeHTTP(response, r)
			var message struct {
				Message struct {
					ID      string           `json:"id"`
					Author  json.RawMessage  `json:"author"`
					Content messages.Content `json:"content"`
				} `json:"message"`
			}
			if response.Code != http.StatusCreated || json.Unmarshal(response.Body.Bytes(), &message) != nil || len(message.Message.Author) != 0 || len(message.Message.Content.Blocks) != 1 || message.Message.Content.Blocks[0].Type != "text" {
				t.Fatalf("composed bot send status=%d body=%s", response.Code, response.Body.String())
			}
			if attempt == 0 {
				firstID = message.Message.ID
			} else if message.Message.ID != firstID {
				t.Fatal("composed bot replay created a second message")
			}
		}
		var storedAuthor, storedKind string
		if err := conn.QueryRow(ctx, `SELECT author_id,author_kind FROM messages WHERE id=$1`, firstID).Scan(&storedAuthor, &storedKind); err != nil || storedAuthor != createdBody.Bot.BotUserID || storedKind != "bot" {
			t.Fatalf("composed Bot writer persisted the wrong identity: author=%s kind=%s err=%v", storedAuthor, storedKind, err)
		}
		assertFeishuHTTPComposition(t, ctx, conn, app, request, tokenBody.Token, directResult.Conversation.ID)
		humanBody, err := json.Marshal(map[string]any{"conversationId": directResult.Conversation.ID, "clientMessageId": "forged-human-fixture", "content": map[string]any{"format": messages.MessageContentFormat, "blocks": []map[string]string{{"type": "text", "text": "synthetic"}}}})
		if err != nil {
			t.Fatal(err)
		}
		forged := httptest.NewRequest(http.MethodPost, "/api/workspace/messages", bytes.NewReader(humanBody))
		forged.Header.Set("Content-Type", "application/json")
		forged.Header.Set("Authorization", "Bearer "+tokenBody.Token)
		forgedResponse := httptest.NewRecorder()
		app.handler.ServeHTTP(forgedResponse, forged)
		if forgedResponse.Code != http.StatusUnauthorized {
			t.Fatalf("Bot token entered human API: %d", forgedResponse.Code)
		}
		server := httptest.NewServer(app.handler)
		defer server.Close()
		connection, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/ws/bot-gateway", &websocket.DialOptions{
			HTTPHeader: http.Header{"Authorization": {"Bearer " + tokenBody.Token}},
		})
		if err != nil {
			t.Fatal("composed gateway dial failed")
		}
		defer connection.CloseNow()
		if err := connection.Write(ctx, websocket.MessageText, []byte(`{"version":1,"type":"hello","lastSequence":0}`)); err != nil {
			t.Fatal(err)
		}
		readCtx, readCancel := context.WithTimeout(ctx, 5*time.Second)
		defer readCancel()
		_, raw, err := connection.Read(readCtx)
		var frame struct {
			Type string `json:"type"`
		}
		if err != nil || json.Unmarshal(raw, &frame) != nil || frame.Type != "ready" {
			t.Fatalf("gateway handshake type=%s err=%v", frame.Type, err)
		}
		ownerRead := request(http.MethodGet, "/api/workspace/bots/"+botID+"/connection", "", nil)
		if ownerRead.Code != http.StatusOK || !strings.Contains(ownerRead.Body.String(), `"status":"connected"`) {
			t.Fatalf("owner connection status=%d", ownerRead.Code)
		}
		ownerTest := request(http.MethodPost, "/api/workspace/bots/"+botID+"/connection/test", "application/json", []byte(`{"ignored":"synthetic"}`))
		if ownerTest.Code != http.StatusOK {
			t.Fatalf("composed owner test status=%d", ownerTest.Code)
		}
		closed := make(chan struct{})
		go func() { app.Close(); close(closed) }()
		for {
			_, _, readErr := connection.Read(readCtx)
			if readErr != nil {
				if websocket.CloseStatus(readErr) != websocket.StatusServiceRestart {
					t.Fatalf("gateway close status=%v", websocket.CloseStatus(readErr))
				}
				break
			}
		}
		select {
		case <-closed:
		case <-time.After(12 * time.Second):
			t.Fatal("application shutdown did not join gateway")
		}
		var status string
		// Use the independent fixture connection: app.Close has closed its pool.
		if err := conn.QueryRow(ctx, `SELECT status FROM workspace_agent_bot_connections WHERE bot_id=$1`, botID).Scan(&status); err != nil || status != "disconnected" {
			t.Fatalf("durable connection after app.Close = %s, err=%v", status, err)
		}
	})
}

type forbiddenUploadBody struct{ t *testing.T }

func (body *forbiddenUploadBody) Read([]byte) (int, error) {
	body.t.Error("declared upload overage read the request body")
	return 0, errors.New("request body must not be read")
}

func (*forbiddenUploadBody) Close() error { return nil }
