package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
)

func TestWorkerPrivateMetricsRecordActualCycleCountsWithoutErrorContent(t *testing.T) {
	app, err := newApplication(context.Background(), config.WorkspaceConfig{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	app.tick(context.Background(), workerProcessor{name: "email", process: func(context.Context) (processResult, error) {
		return processResult{Claimed: 3, Sent: 1, Retried: 2}, errors.New("secret-provider-error")
	}})
	router := app.healthHandler(config.WorkspaceConfig{})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/metrics?secret=private-query", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("metrics=%d", response.Code)
	}
	for _, sample := range []string{
		`duallane_worker_results_total{operation="email",result="claimed"} 3`,
		`duallane_worker_results_total{operation="email",result="completed"} 1`,
		`duallane_worker_results_total{operation="email",result="retried"} 2`,
	} {
		if !strings.Contains(response.Body.String(), sample) {
			t.Fatalf("missing safe result sample %s", sample)
		}
	}
	for _, private := range []string{"secret-provider-error", "private-query", "duallane_worker_backlog{"} {
		if strings.Contains(response.Body.String(), private) {
			t.Fatalf("metrics contained unavailable/private value %s", private)
		}
	}
	rejected := httptest.NewRecorder()
	router.ServeHTTP(rejected, httptest.NewRequest(http.MethodPost, "/metrics", nil))
	if rejected.Code != http.StatusMethodNotAllowed {
		t.Fatalf("metrics POST=%d", rejected.Code)
	}
}
