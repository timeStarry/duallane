package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
)

func TestValidateOnlyNeverInvokesConfiguredProcessors(t *testing.T) {
	processor := workerProcessor{name: "email", interval: time.Millisecond, process: func(context.Context) (processResult, error) {
		t.Error("validate-only claimed a job")
		return processResult{}, nil
	}}
	app := &application{validateOnly: true, processors: []workerProcessor{processor}, startupDelay: 0}
	app.tick(context.Background(), processor)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); app.run(ctx) }()
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("passive worker did not stop")
	}
	// A constructed validator without its required pool cannot prove readiness.
	w := httptest.NewRecorder()
	app.healthHandler(config.WorkspaceConfig{}).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), `"mode":"validate-only"`) {
		t.Fatalf("passive health=%d %s", w.Code, w.Body.String())
	}
}
