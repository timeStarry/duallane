//go:build postgres_integration

package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
)

func assertPassiveWorkspaceComposition(t *testing.T, ctx context.Context, dsn, webDir string) {
	t.Helper()
	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	query.Set("default_transaction_read_only", "on")
	parsed.RawQuery = query.Encode()
	t.Setenv("DATABASE_URL", parsed.String())
	app, err := newApplication(ctx, config.WorkspaceConfig{
		Enabled: true, CandidateHealthOnly: true, Environment: "production", AppVersion: "test", Commit: "fixture",
		StorageDriver: "local", DataDir: t.TempDir(), GitHubOAuthTimeout: time.Second,
		EmoteCatalogPath: filepath.Join(webDir, "shared/emote-packs.json"), ReleaseCatalogPath: filepath.Join(webDir, "shared/echo-release-guides.json"),
		MigrationsDir: filepath.Join(webDir, "server/migrations"),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	if app.backgroundDone != nil || app.shutdownBotGateway != nil || app.pool == nil {
		t.Fatal("passive candidate started background work or skipped dependency composition")
	}
	var readOnly string
	if err := app.pool.QueryRow(ctx, "SHOW default_transaction_read_only").Scan(&readOnly); err != nil || readOnly != "on" {
		t.Fatalf("read-only proof=%q err=%v", readOnly, err)
	}
	w := httptest.NewRecorder()
	app.handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"mode":"candidate-health-only"`) || !strings.Contains(w.Body.String(), `"state":"ready"`) {
		t.Fatalf("candidate readiness=%d %s", w.Code, w.Body.String())
	}
	for _, path := range []string{"/api/workspace/bootstrap", "/api/workspace/invites", "/api/auth/github/start", "/api/bot-gateway/session", "/ws/workspace", "/ws/bot-gateway"} {
		w := httptest.NewRecorder()
		app.handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("passive route %s=%d", path, w.Code)
		}
	}
}
