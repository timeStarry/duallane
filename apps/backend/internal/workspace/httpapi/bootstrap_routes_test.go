package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/bootstrap"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
)

type fakeBootstrapService struct {
	result  bootstrap.Bootstrap
	actorID string
	meta    auth.RequestMeta
	calls   int
	err     error
}

func (service *fakeBootstrapService) Get(_ context.Context, actorID string, meta auth.RequestMeta) (bootstrap.Bootstrap, error) {
	service.actorID = actorID
	service.meta = meta
	service.calls++
	return service.result, service.err
}

func TestBootstrapRouteKeepsTopLevelCompatibilityShape(t *testing.T) {
	service := &fakeBootstrapService{result: bootstrap.Bootstrap{AppVersion: "1.2.3", EventCursor: 7}}
	router := NewRouter(RouterOptions{
		Gate: gate.New("true"), ActorResolver: &fakeResolver{actor: &auth.Actor{ID: "owner", Kind: "human", Role: "owner"}},
		Bootstrap: service, TrustProxy: true,
	})
	request := httptest.NewRequest(http.MethodGet, "/api/workspace/bootstrap", nil)
	request.Header.Set("X-Request-ID", "bootstrap-request")
	request.Header.Set("X-Forwarded-For", "203.0.113.8")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["appVersion"] != "1.2.3" || payload["eventCursor"] != float64(7) || payload["bootstrap"] != nil {
		t.Fatalf("payload = %#v", payload)
	}
	if service.actorID != "owner" || service.meta.RequestID != "bootstrap-request" || service.meta.IPAddress != "203.0.113.8" {
		t.Fatalf("service input = actor:%q meta:%#v", service.actorID, service.meta)
	}
}

func TestBootstrapGateRunsBeforeResolverAndService(t *testing.T) {
	resolver := &fakeResolver{actor: &auth.Actor{ID: "owner"}}
	service := &fakeBootstrapService{}
	router := NewRouter(RouterOptions{Gate: gate.New("false"), ActorResolver: resolver, Bootstrap: service})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/workspace/bootstrap", nil))
	if response.Code != http.StatusServiceUnavailable || resolver.calls != 0 || service.calls != 0 {
		t.Fatalf("disabled bootstrap = status:%d resolver:%d service:%d body:%s", response.Code, resolver.calls, service.calls, response.Body.String())
	}
}
