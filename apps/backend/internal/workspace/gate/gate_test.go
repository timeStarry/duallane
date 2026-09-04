package gate

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNewRequiresExactTrue(t *testing.T) {
	tests := map[string]bool{
		"":       false,
		"TRUE":   false,
		"1":      false,
		" true ": false,
		"true":   true,
	}
	for value, want := range tests {
		if got := New(value).Enabled(); got != want {
			t.Errorf("New(%q).Enabled() = %v, want %v", value, got, want)
		}
	}
}

func TestMiddlewareBlocksBeforeWrappedHandler(t *testing.T) {
	called := false
	handler := New("false").Middleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/workspace/bootstrap", nil))

	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusServiceUnavailable)
	}
	if called {
		t.Fatal("wrapped handler was called while Workspace was disabled")
	}
	var body map[string]map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode disabled response: %v", err)
	}
	if body["error"]["code"] != DisabledCode || body["error"]["message"] != DisabledMessage {
		t.Fatalf("disabled response = %#v", body)
	}
}

func TestProjectHealthDistinguishesDisabledAndDependencyFailure(t *testing.T) {
	disabled := ProjectHealth(HealthInput{Service: "workspace", Live: true, Workspace: New("false")})
	if disabled.OK != true || disabled.State != StateDisabled || disabled.Lane != "disabled" {
		t.Fatalf("disabled health = %#v", disabled)
	}
	notReady := ProjectHealth(HealthInput{Service: "workspace", Live: true, DatabaseReady: false, ObjectStoreReady: true, Workspace: New("true")})
	if notReady.OK != true || notReady.State != StateNotReady || notReady.Lane != "not_ready" {
		t.Fatalf("not-ready health = %#v", notReady)
	}
	ready := ProjectHealth(HealthInput{Service: "workspace", Version: "1.0.0", Commit: "abc", Live: true, DatabaseReady: true, ObjectStoreReady: true, Workspace: New("true")})
	if ready.OK != true || ready.State != StateReady || ready.Lane != "ready" || ready.AppVersion != "1.0.0" || ready.Version != "1.0.0" || ready.Commit != "abc" {
		t.Fatalf("ready health = %#v", ready)
	}
	encoded, err := json.Marshal(ready)
	if err != nil || !strings.Contains(string(encoded), `"appVersion":"1.0.0"`) {
		t.Fatalf("health projection omitted appVersion: %s (err=%v)", encoded, err)
	}
}

func TestPublicHealthPreservesCurrentContract(t *testing.T) {
	projection := ProjectPublicHealth(HealthInput{Live: true, Version: "1.2.3", Workspace: New("false")})
	if projection != (PublicHealthProjection{OK: true, Service: "duallane", Lane: "ready", AppVersion: "1.2.3"}) {
		t.Fatalf("public health = %#v", projection)
	}
	encoded, err := json.Marshal(projection)
	if err != nil || string(encoded) != `{"ok":true,"service":"duallane","lane":"ready","appVersion":"1.2.3"}` {
		t.Fatalf("public health JSON = %s (err=%v)", encoded, err)
	}
}

func TestHealthHandlerKeepsPublicHealthLiveWhileReadinessIsPrivate(t *testing.T) {
	tests := []struct {
		name   string
		input  HealthInput
		status int
	}{
		{
			name:   "disabled",
			input:  HealthInput{Live: true, Workspace: New("false")},
			status: http.StatusOK,
		},
		{
			name:   "not ready",
			input:  HealthInput{Live: true, Workspace: New("true")},
			status: http.StatusOK,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			HealthHandler(func() HealthInput { return test.input }).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/health", nil))
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d", response.Code, test.status)
			}
		})
	}
	response := httptest.NewRecorder()
	ReadinessHandler(func() HealthInput {
		return HealthInput{Live: true, Workspace: New("true")}
	}).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("readiness status = %d, want %d", response.Code, http.StatusServiceUnavailable)
	}
}
