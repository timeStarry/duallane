package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
)

func TestPassiveRouterNeverAcceptsBusinessOrWebSocketRequests(t *testing.T) {
	health := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	router := candidateHealthRouter(health, health)
	for _, path := range []string{"/api/workspace/status", "/api/workspace/invites", "/api/auth/github/start?code=private", "/api/bot-gateway/cards", "/ws/workspace", "/ws/bot-gateway", "/readyz/extra"} {
		for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodDelete} {
			w := httptest.NewRecorder()
			router.ServeHTTP(w, httptest.NewRequest(method, path, strings.NewReader("private payload")))
			if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "workspace.candidate_passive") || strings.Contains(w.Body.String(), "private") || len(w.Result().Cookies()) != 0 {
				t.Fatalf("passive admission %s %s = %d %s", method, path, w.Code, w.Body.String())
			}
		}
	}
	for _, path := range []string{"/api/health", "/readyz"} {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("health %s=%d", path, w.Code)
		}
	}
}

func TestPassiveBlobStoreRequiresExistingRoot(t *testing.T) {
	_, err := newBlobStore(context.Background(), config.WorkspaceConfig{CandidateHealthOnly: true, DataDir: filepath.Join(t.TempDir(), "not-provisioned")})
	if err == nil {
		t.Fatal("passive startup provisioned a data root")
	}
}
