package main

import (
	"context"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/ntfy"
)

func TestDisabledWorkerDoesNotOpenDatabase(t *testing.T) {
	app, err := newApplication(context.Background(), config.WorkspaceConfig{Enabled: false, NtfyWorkerEnabled: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if app.pool != nil || app.ntfyProcessor != nil {
		t.Fatalf("disabled worker dependencies = %#v", app)
	}
}

func TestWorkerRunsImmediatelyWhenConfiguredAndStops(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	called := make(chan struct{}, 1)
	app := &application{
		startupDelay: 0,
		interval:     time.Hour,
		ntfyProcessor: func(context.Context) (ntfy.ProcessResult, error) {
			called <- struct{}{}
			return ntfy.ProcessResult{Claimed: 1, Sent: 1}, nil
		},
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
