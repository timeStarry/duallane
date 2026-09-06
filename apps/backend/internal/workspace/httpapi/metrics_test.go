package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
)

type httpMetricObservation struct {
	method, route string
	status        int
	duration      time.Duration
}

func TestHTTPMetricsUseCompletedRouteTemplate(t *testing.T) {
	var observed httpMetricObservation
	router := NewRouter(RouterOptions{Gate: gate.New("true"), ObserveHTTP: func(method, route string, status int, duration time.Duration) {
		observed = httpMetricObservation{method, route, status, duration}
	}})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/workspace/invites/private-resource/revoke?token=private-secret", nil))
	if observed.method != http.MethodPost || observed.route != "/api/workspace/invites/{inviteId}/revoke" || observed.status != http.StatusUnauthorized || observed.duration < 0 {
		t.Fatalf("observation=%+v", observed)
	}
	templates, err := RouteTemplates()
	if err != nil || !slices.Contains(templates, observed.route) {
		t.Fatalf("route missing from static allowlist: %v", err)
	}
	router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/private-unknown?secret=private-secret", nil))
	if observed.route != "" || observed.status != http.StatusNotFound {
		t.Fatalf("unknown route retained request data: %+v", observed)
	}
}

func TestHTTPMetricsPreserveWebSocketUpgrade(t *testing.T) {
	observed := make(chan httpMetricObservation, 1)
	accepted := make(chan error, 1)
	router := NewRouter(RouterOptions{
		Gate: gate.New("true"),
		ObserveHTTP: func(method, route string, status int, duration time.Duration) {
			observed <- httpMetricObservation{method, route, status, duration}
		},
		Realtime: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			connection, err := websocket.Accept(w, r, nil)
			accepted <- err
			if err == nil {
				_ = connection.CloseNow()
			}
		}),
	})
	server := httptest.NewServer(router)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	connection, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/ws/workspace", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.CloseNow()
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("upgrade=%d", response.StatusCode)
	}
	select {
	case err := <-accepted:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	select {
	case sample := <-observed:
		if sample.route != "/ws/workspace" || sample.status != http.StatusSwitchingProtocols {
			t.Fatalf("upgrade observation=%+v", sample)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}
