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
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	"github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/emotes"
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
}

type forbiddenUploadBody struct{ t *testing.T }

func (body *forbiddenUploadBody) Read([]byte) (int, error) {
	body.t.Error("declared upload overage read the request body")
	return 0, errors.New("request body must not be read")
}

func (*forbiddenUploadBody) Close() error { return nil }
