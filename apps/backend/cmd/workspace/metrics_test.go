package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
)

func TestWorkspacePrivateMetricsUseTemplatesAndNeverRequestIdentifiers(t *testing.T) {
	app, err := newApplication(context.Background(), config.WorkspaceConfig{Enabled: false, AppVersion: "test"})
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	for _, path := range []string{"/api/workspace/messages/private-message-id?token=private-query", "/private-unknown-path?secret=private-secret"} {
		w := httptest.NewRecorder()
		app.handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
	}
	w := httptest.NewRecorder()
	app.handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "duallane_workspace_http_requests_total") || !strings.Contains(w.Body.String(), `route="unknown"`) {
		t.Fatalf("metrics=%d %s", w.Code, w.Body.String())
	}
	for _, secret := range []string{"private-message-id", "private-query", "private-unknown-path", "private-secret"} {
		if strings.Contains(w.Body.String(), secret) {
			t.Fatalf("metrics exposed %s", secret)
		}
	}
	post := httptest.NewRecorder()
	app.handler.ServeHTTP(post, httptest.NewRequest(http.MethodPost, "/metrics", nil))
	if post.Code != http.StatusMethodNotAllowed {
		t.Fatalf("metrics mutation accepted: %d", post.Code)
	}
}
