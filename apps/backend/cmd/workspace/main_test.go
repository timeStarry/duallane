package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/releases"
)

func TestDisabledApplicationDoesNotRequireWorkspaceDependencies(t *testing.T) {
	app, err := newApplication(context.Background(), config.WorkspaceConfig{
		Host: "127.0.0.1", Port: 8787, AppVersion: "test", Environment: "production",
		GitHubOAuthTimeout: 8 * time.Second, Enabled: false,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	if app.pool != nil {
		t.Fatal("disabled application opened a PostgreSQL pool")
	}

	health := httptest.NewRecorder()
	app.handler.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if health.Code != http.StatusOK || health.Body.String() != "{\"ok\":true,\"service\":\"duallane\",\"lane\":\"ready\",\"appVersion\":\"test\"}\n" {
		t.Fatalf("health = %d %s", health.Code, health.Body.String())
	}

	workspace := httptest.NewRecorder()
	app.handler.ServeHTTP(workspace, httptest.NewRequest(http.MethodPost, "/api/workspace/invites", strings.NewReader(`{"code":"must-not-be-read"}`)))
	if workspace.Code != http.StatusServiceUnavailable || strings.Contains(workspace.Body.String(), "must-not-be-read") {
		t.Fatalf("disabled workspace = %d %s", workspace.Code, workspace.Body.String())
	}

	oauth := httptest.NewRecorder()
	app.handler.ServeHTTP(oauth, httptest.NewRequest(http.MethodGet, "/api/auth/github/start?invite=must-not-be-read", nil))
	if oauth.Code != http.StatusServiceUnavailable || len(oauth.Result().Cookies()) != 0 {
		t.Fatalf("disabled OAuth = %d cookies=%#v body=%s", oauth.Code, oauth.Result().Cookies(), oauth.Body.String())
	}
}

func TestApplicationCloseCancelsAndJoinsBackgroundWork(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	app := &application{cancel: cancel, backgroundDone: done}
	go func() { <-ctx.Done(); close(done) }()
	closed := make(chan struct{})
	go func() { app.Close(); app.Close(); close(closed) }()
	select {
	case <-closed:
		if ctx.Err() != context.Canceled {
			t.Fatal("background context was not canceled")
		}
	case <-time.After(time.Second):
		t.Fatal("background work was not joined")
	}
}

func TestNewBlobStoreUsesLocalDriverWithoutS3Secrets(t *testing.T) {
	store, err := newBlobStore(context.Background(), config.WorkspaceConfig{StorageDriver: "local", DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := store.(*platformstorage.LocalBlobStore); !ok {
		t.Fatalf("local store = %T", store)
	}
}

func TestApplicationCloseJoinsGatewayCleanupWithIndependentDeadline(t *testing.T) {
	root, cancel := context.WithCancel(context.Background())
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	app := &application{cancel: cancel, shutdownBotGateway: func(ctx context.Context) error {
		if root.Err() != context.Canceled {
			t.Error("application root was not canceled before gateway drain")
		}
		if ctx.Err() != nil {
			t.Error("cleanup inherited canceled application root")
		}
		if _, ok := ctx.Deadline(); !ok {
			t.Error("cleanup lacks deadline")
		}
		close(entered)
		<-release
		return nil
	}}
	go func() { app.Close(); close(done) }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("gateway cleanup was not called")
	}
	select {
	case <-done:
		t.Fatal("Close did not join gateway cleanup")
	default:
	}
	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Close did not complete after cleanup")
	}
	app.Close()
}

func TestEnabledApplicationRejectsMissingCatalogBeforeOpeningDatabase(t *testing.T) {
	t.Setenv("DATABASE_URL", "not a connection string")
	app, err := newApplication(context.Background(), config.WorkspaceConfig{
		Enabled: true, EmoteCatalogPath: filepath.Join(t.TempDir(), "missing.json"),
	})
	if app != nil || err == nil || !strings.Contains(err.Error(), "open emote catalog") {
		t.Fatalf("application=%v error=%v", app, err)
	}
}

func TestEnabledApplicationRejectsMissingReleaseCatalogBeforeOpeningDatabase(t *testing.T) {
	t.Setenv("DATABASE_URL", "not a connection string")
	app, err := newApplication(context.Background(), config.WorkspaceConfig{
		Enabled: true, EmoteCatalogPath: filepath.Join("../../../web/shared", "emote-packs.json"),
		ReleaseCatalogPath: filepath.Join(t.TempDir(), "missing-release.json"),
	})
	if app != nil || !errors.Is(err, releases.ErrCatalogInvalid) {
		t.Fatalf("application=%v error=%v", app, err)
	}
}
