package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
)

type nodeRouteObservation struct {
	Method   string `json:"method"`
	Path     string `json:"path"`
	Lane     string `json:"lane"`
	Disabled *struct {
		Status int `json:"status"`
		Body   any `json:"body"`
	} `json:"disabled"`
}

func loadNodeRouteInventory(t *testing.T) []nodeRouteObservation {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate Node route inventory")
	}
	data, err := os.ReadFile(filepath.Join(filepath.Dir(filename), "../../../api/node-routes.json"))
	if err != nil {
		t.Fatal(err)
	}
	var inventory struct {
		SchemaVersion int                    `json:"schemaVersion"`
		Routes        []nodeRouteObservation `json:"routes"`
	}
	if err := json.Unmarshal(data, &inventory); err != nil {
		t.Fatal(err)
	}
	if inventory.SchemaVersion != 1 || len(inventory.Routes) == 0 {
		t.Fatal("invalid Node route inventory")
	}
	return inventory.Routes
}

func TestWorkspaceRegistersEveryNodePublicRoute(t *testing.T) {
	router := NewRouter(RouterOptions{Gate: gate.New("false"), AuthRoutes: &auth.HTTPHandler{}})
	registered := map[string]bool{}
	err := chi.Walk(router.(chi.Routes), func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		registered[method+" "+route] = true
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, route := range loadNodeRouteInventory(t) {
		if route.Lane != "workspace" {
			continue
		}
		key := route.Method + " " + route.Path
		if !registered[key] {
			t.Errorf("Node public route is not registered: %s", key)
		}
	}
}

func TestAllWorkspaceRoutesPreserveNodeDisabledResponse(t *testing.T) {
	parameter := regexp.MustCompile(`\{[^}]+\}`)
	for _, rawFlag := range []string{"", "false", "TRUE", " true ", "1"} {
		resolver := &fakeResolver{actor: &auth.Actor{ID: "must-not-resolve"}}
		router := NewRouter(RouterOptions{Gate: gate.New(rawFlag), AuthRoutes: &auth.HTTPHandler{}, ActorResolver: resolver})
		for _, route := range loadNodeRouteInventory(t) {
			if route.Disabled == nil {
				continue
			}
			t.Run(rawFlag+"/"+route.Method+" "+route.Path, func(t *testing.T) {
				request := httptest.NewRequest(route.Method, parameter.ReplaceAllString(route.Path, "contract-id"), strings.NewReader("{}"))
				request.Header.Set("Content-Type", "application/json")
				response := httptest.NewRecorder()
				router.ServeHTTP(response, request)
				var body any
				if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
					t.Fatalf("non-JSON response: status=%d", response.Code)
				}
				if response.Code != route.Disabled.Status || !reflect.DeepEqual(body, route.Disabled.Body) {
					t.Errorf("disabled response differs: status=%d body=%s", response.Code, response.Body.String())
				}
			})
		}
		if resolver.calls != 0 {
			t.Errorf("flag %q resolved %d actors while disabled", rawFlag, resolver.calls)
		}
	}
}
