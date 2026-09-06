package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRunAcceptsLoopbackHealthAndReadiness(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/api/health":
			_, _ = response.Write([]byte(`{"ok":true,"service":"duallane"}`))
		case "/readyz":
			_, _ = response.Write([]byte(`{"ok":true,"state":"ready"}`))
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	if !run([]string{server.URL + "/api/health"}) {
		t.Fatal("valid /api/health projection was rejected")
	}
	if !run([]string{server.URL + "/readyz"}) {
		t.Fatal("valid /readyz projection was rejected")
	}
}

func TestRunRejectsMalformedNon200AndWrongState(t *testing.T) {
	tests := []struct {
		name   string
		status int
		body   string
		path   string
	}{
		{name: "malformed", status: http.StatusOK, body: `{"ok":true`, path: "/api/health"},
		{name: "non200", status: http.StatusServiceUnavailable, body: `{"ok":true}`, path: "/api/health"},
		{name: "wrong state", status: http.StatusOK, body: `{"ok":true,"state":"disabled"}`, path: "/readyz"},
		{name: "missing state", status: http.StatusOK, body: `{"ok":true}`, path: "/readyz"},
		{name: "false ok", status: http.StatusOK, body: `{"ok":false,"state":"ready"}`, path: "/readyz"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				response.WriteHeader(test.status)
				_, _ = response.Write([]byte(test.body))
			}))
			defer server.Close()
			if run([]string{server.URL + test.path}) {
				t.Fatal("invalid health projection was accepted")
			}
		})
	}
}

func TestRunRejectsOversizeResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(response, `{"ok":true,"state":"ready","padding":"%s"}`, strings.Repeat("x", maxResponseBytes))
	}))
	defer server.Close()

	if run([]string{server.URL + "/readyz"}) {
		t.Fatal("oversize response was accepted")
	}
}

func TestRunDoesNotFollowRedirect(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		requests++
		response.Header().Set("Location", "http://8.8.8.8:80/api/health")
		response.WriteHeader(http.StatusFound)
	}))
	defer server.Close()

	if run([]string{server.URL + "/api/health"}) {
		t.Fatal("redirect response was accepted")
	}
	if requests != 1 {
		t.Fatalf("redirect caused %d local requests, want 1", requests)
	}
}

func TestRunTimeoutIsBounded(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		<-request.Context().Done()
	}))
	defer server.Close()

	started := time.Now()
	if run([]string{server.URL + "/api/health"}) {
		t.Fatal("timed out request was accepted")
	}
	if elapsed := time.Since(started); elapsed > requestTimeout+time.Second {
		t.Fatalf("timeout took %s, want at most %s", elapsed, requestTimeout+time.Second)
	}
}

func TestParseTargetRejectsNonLoopbackAndUnsupportedTargets(t *testing.T) {
	for _, target := range []string{
		"http://8.8.8.8:80/api/health",
		"http://localhost:80/api/health",
		"http://127.0.0.1:0/api/health",
		"http://127.0.0.1:65536/api/health",
		"http://127.0.0.1/api/health",
		"https://127.0.0.1:443/api/health",
		"http://127.0.0.1:80/other",
		"http://127.0.0.1:80/api/health?secret=value",
		"http://user:password@127.0.0.1:80/api/health",
	} {
		if _, _, ok := parseTarget([]string{target}); ok {
			t.Errorf("parseTarget accepted %q", target)
		}
	}
}

func TestDialLoopbackRejectsExternalAddressWithoutDialing(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := dialLoopback(ctx, "tcp", "8.8.8.8:80"); err == nil {
		t.Fatal("external address was accepted by loopback dialer")
	}
}
