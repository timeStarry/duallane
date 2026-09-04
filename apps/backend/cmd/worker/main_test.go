package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
)

func TestDisabledWorkerDoesNotOpenDatabase(t *testing.T) {
	app, err := newApplication(context.Background(), config.WorkspaceConfig{Enabled: false, NtfyWorkerEnabled: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if app.pool != nil || len(app.processors) != 0 {
		t.Fatalf("disabled worker dependencies = %#v", app)
	}
}

func TestWorkerHealthSeparatesLivenessAndReadiness(t *testing.T) {
	runtimeConfig := config.WorkspaceConfig{AppVersion: "0.16.0", Commit: "abc123"}
	app := &application{processors: []workerProcessor{{name: "email"}}}
	handler := app.healthHandler(runtimeConfig)

	live := httptest.NewRecorder()
	handler.ServeHTTP(live, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if live.Code != http.StatusOK {
		t.Fatalf("liveness status = %d", live.Code)
	}
	var liveBody healthResponse
	if err := json.NewDecoder(live.Body).Decode(&liveBody); err != nil || !liveBody.OK || liveBody.Service != serviceName || liveBody.Version != "0.16.0" || liveBody.Commit != "abc123" {
		t.Fatalf("liveness = %#v, %v", liveBody, err)
	}

	ready := httptest.NewRecorder()
	handler.ServeHTTP(ready, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if ready.Code != http.StatusServiceUnavailable {
		t.Fatalf("readiness status = %d body=%s", ready.Code, ready.Body.String())
	}
	var readyBody healthResponse
	if err := json.NewDecoder(ready.Body).Decode(&readyBody); err != nil || readyBody.OK || readyBody.State != "not_ready" {
		t.Fatalf("readiness = %#v, %v", readyBody, err)
	}

	idle := httptest.NewRecorder()
	(&application{}).healthHandler(runtimeConfig).ServeHTTP(idle, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if idle.Code != http.StatusOK {
		t.Fatalf("disabled worker readiness = %d body=%s", idle.Code, idle.Body.String())
	}
}

func TestWorkerRunsImmediatelyWhenConfiguredAndStops(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	called := make(chan struct{}, 1)
	app := &application{
		startupDelay: 0,
		processors: []workerProcessor{{name: "ntfy", interval: time.Hour, process: func(context.Context) (processResult, error) {
			called <- struct{}{}
			return processResult{Claimed: 1, Sent: 1}, nil
		}}},
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		app.run(ctx)
	}()
	select {
	case <-called:
		cancel()
	case <-time.After(time.Second):
		t.Fatal("worker did not run initial cycle")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("worker did not stop after cancellation")
	}
}
