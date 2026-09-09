package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
)

func TestReadinessRechecksRequiredDependenciesWithoutExposingErrors(t *testing.T) {
	failed := false
	probe := func(ctx context.Context) error {
		if _, ok := ctx.Deadline(); !ok {
			t.Error("unbounded readiness probe")
		}
		if failed {
			return errors.New("private connection string")
		}
		return nil
	}
	handler := readinessHandler(func() gate.HealthInput {
		return gate.HealthInput{Live: true, Workspace: gate.New("true")}
	}, probe, probe)
	for _, status := range []int{http.StatusOK, http.StatusServiceUnavailable} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/readyz", nil))
		if w.Code != status || strings.Contains(w.Body.String(), "private") {
			t.Fatalf("readiness=%d %s", w.Code, w.Body.String())
		}
		failed = true
	}
}

func TestDisabledAndStoppingReadinessNeverProbeDependencies(t *testing.T) {
	probe := func(context.Context) error { t.Fatal("dependency accessed"); return nil }
	for _, input := range []gate.HealthInput{
		{Live: true, Workspace: gate.New("false")},
		{Live: false, Workspace: gate.New("true")},
	} {
		w := httptest.NewRecorder()
		readinessHandler(func() gate.HealthInput { return input }, probe, probe).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/readyz", nil))
		want := http.StatusOK
		if !input.Live {
			want = http.StatusServiceUnavailable
		}
		if w.Code != want {
			t.Fatalf("readiness=%d want=%d", w.Code, want)
		}
	}
}
