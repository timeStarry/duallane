package workspacecontract

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers"
	"github.com/getkin/kin-openapi/routers/legacy"
)

const (
	workspaceCoreContractPath = "../../api/workspace-core.yaml"
	workspaceCoreFixturePath  = "testdata/node-core.json"
	nodeRoutesPath            = "../../api/node-routes.json"
)

type coreRoute struct {
	Method   string `json:"method"`
	Path     string `json:"path"`
	NodePath string `json:"nodePath"`
	Source   string `json:"source"`
}

type coreFixture struct {
	SchemaVersion int            `json:"schemaVersion"`
	Source        fixtureSource  `json:"source"`
	Routes        []coreRoute    `json:"routes"`
	Scenarios     []coreScenario `json:"scenarios"`
}

type fixtureSource struct {
	NodeRoutes     string `json:"nodeRoutes"`
	RouteSource    string `json:"routeSource"`
	FixtureRuntime string `json:"fixtureRuntime"`
}

type coreScenario struct {
	Name        string          `json:"name"`
	Request     fixtureRequest  `json:"request"`
	Response    fixtureResponse `json:"response"`
	SideEffects json.RawMessage `json:"sideEffects"`
}

type fixtureRequest struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    json.RawMessage   `json:"body"`
}

type fixtureResponse struct {
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body"`
}

var expectedCoreRoutes = []coreRoute{
	{Method: http.MethodGet, Path: "/api/auth/github/start"},
	{Method: http.MethodGet, Path: "/api/auth/github/callback"},
	{Method: http.MethodPost, Path: "/api/auth/logout"},
	{Method: http.MethodGet, Path: "/api/workspace/bootstrap"},
	{Method: http.MethodGet, Path: "/api/workspace/statistics"},
	{Method: http.MethodGet, Path: "/api/workspace/members"},
	{Method: http.MethodPatch, Path: "/api/workspace/me/profile"},
	{Method: http.MethodGet, Path: "/api/workspace/member-visibility/{userId}"},
	{Method: http.MethodPut, Path: "/api/workspace/member-visibility/{userId}"},
	{Method: http.MethodPatch, Path: "/api/workspace/members/{userId}/role"},
	{Method: http.MethodDelete, Path: "/api/workspace/members/{userId}"},
	{Method: http.MethodPut, Path: "/api/workspace/members/{userId}/remark"},
	{Method: http.MethodDelete, Path: "/api/workspace/members/{userId}/remark"},
	{Method: http.MethodGet, Path: "/api/workspace/conversations"},
	{Method: http.MethodPost, Path: "/api/workspace/conversations"},
	{Method: http.MethodGet, Path: "/api/workspace/conversations/{conversationId}"},
	{Method: http.MethodGet, Path: "/api/workspace/conversations/{conversationId}/messages"},
	{Method: http.MethodPost, Path: "/api/workspace/conversations/{conversationId}/read"},
	{Method: http.MethodPatch, Path: "/api/workspace/conversations/{conversationId}/notification"},
	{Method: http.MethodPatch, Path: "/api/workspace/groups/{conversationId}"},
	{Method: http.MethodPost, Path: "/api/workspace/groups/{conversationId}/leave"},
	{Method: http.MethodPost, Path: "/api/workspace/groups/{conversationId}/members"},
	{Method: http.MethodDelete, Path: "/api/workspace/groups/{conversationId}/members/{userId}"},
	{Method: http.MethodGet, Path: "/api/workspace/groups/{conversationId}/pins"},
	{Method: http.MethodPost, Path: "/api/workspace/groups/{conversationId}/pins"},
	{Method: http.MethodDelete, Path: "/api/workspace/groups/{conversationId}/pins/{messageId}"},
	{Method: http.MethodPost, Path: "/api/workspace/messages"},
	{Method: http.MethodPost, Path: "/api/workspace/messages/{messageId}/reactions"},
	{Method: http.MethodDelete, Path: "/api/workspace/messages/{messageId}/reactions/{emoteKey}"},
	{Method: http.MethodPost, Path: "/api/workspace/messages/{messageId}/recall"},
	{Method: http.MethodPut, Path: "/api/workspace/messages/{messageId}/hidden"},
	{Method: http.MethodDelete, Path: "/api/workspace/messages/{messageId}/hidden"},
}

func TestWorkspaceCoreContractIsVersionedAndTraceable(t *testing.T) {
	harness := loadCoreContract(t)
	if got, want := len(harness.fixture.Routes), len(expectedCoreRoutes); got != want {
		t.Fatalf("fixture route count = %d, want %d", got, want)
	}
	if got, want := len(harness.fixture.Scenarios), 29; got != want {
		t.Fatalf("Node fixture scenario count = %d, want %d", got, want)
	}
	if harness.fixture.Source.NodeRoutes != "apps/backend/api/node-routes.json" {
		t.Fatalf("fixture node route source = %q", harness.fixture.Source.NodeRoutes)
	}
	if harness.fixture.Source.RouteSource != "apps/web/server/index.mjs" {
		t.Fatalf("fixture route source = %q", harness.fixture.Source.RouteSource)
	}

	fixtureRoutes := make(map[string]coreRoute, len(harness.fixture.Routes))
	for _, route := range harness.fixture.Routes {
		fixtureRoutes[route.Method+" "+route.Path] = route
	}
	nodeRoutes := loadNodeRoutes(t)
	for _, expected := range expectedCoreRoutes {
		fixtureRoute, ok := fixtureRoutes[expected.Method+" "+expected.Path]
		if !ok {
			t.Fatalf("Node fixture route inventory is missing %s", expected)
		}
		routePath := harness.doc.Paths.Find(expected.Path)
		if routePath == nil {
			t.Fatalf("OpenAPI is missing core route %s %s", expected.Method, expected.Path)
		}
		if routePath.Operations()[expected.Method] == nil {
			t.Fatalf("OpenAPI is missing core operation %s %s", expected.Method, expected.Path)
		}
		nodeRoute, ok := nodeRoutes[expected.Method+" "+expected.Path]
		if !ok {
			t.Fatalf("node-routes.json is missing %s", expected)
		}
		if fixtureRoute.NodePath != nodeRoute.NodePath || fixtureRoute.Source != nodeRoute.Source {
			t.Fatalf("fixture route %s = %#v, want Node inventory %#v", expected, fixtureRoute, nodeRoute)
		}
	}
	if harness.doc.Components.SecuritySchemes["workspaceSession"] == nil {
		t.Fatal("OpenAPI is missing the Workspace session cookie security scheme")
	}

	for _, expected := range expectedCoreRoutes {
		key := expected.Method + " " + expected.Path
		actual, ok := nodeRoutes[key]
		if !ok {
			t.Fatalf("node-routes.json is missing %s", key)
		}
		if actual.Source != "apps/web/server/index.mjs" {
			t.Fatalf("%s source = %q, want apps/web/server/index.mjs", key, actual.Source)
		}
	}
}

func TestNodeCoreFixturesCarryAuthAndMutationSideEffects(t *testing.T) {
	harness := loadCoreContract(t)
	for _, test := range []struct {
		name        string
		auditAction string
		eventType   string
	}{
		{name: "login-rejected-not-invited", auditAction: "login.rejected"},
		{name: "message-create-write", auditAction: "message.create", eventType: "message.created"},
	} {
		t.Run(test.name, func(t *testing.T) {
			scenario := findCoreScenario(t, harness.fixture, test.name)
			if len(scenario.SideEffects) == 0 {
				t.Fatal("fixture omitted the required side-effect contract")
			}
			var effects struct {
				Audit struct {
					Action string `json:"action"`
					Result string `json:"result"`
				} `json:"audit"`
				Event struct {
					Type string `json:"type"`
				} `json:"event"`
			}
			if err := json.Unmarshal(scenario.SideEffects, &effects); err != nil {
				t.Fatalf("decode side-effect contract: %v", err)
			}
			wantResult := "success"
			if test.name == "login-rejected-not-invited" {
				wantResult = "rejected"
			}
			if effects.Audit.Action != test.auditAction || effects.Audit.Result != wantResult {
				t.Fatalf("side-effect audit = %#v, want action %q result %q", effects.Audit, test.auditAction, wantResult)
			}
			if test.eventType != "" && effects.Event.Type != test.eventType {
				t.Fatalf("side-effect event = %q, want %q", effects.Event.Type, test.eventType)
			}
		})
	}
}

func TestWorkspaceCoreContractUsesSessionSecurityForWorkspaceRoutes(t *testing.T) {
	harness := loadCoreContract(t)
	publicRoutes := map[string]bool{
		http.MethodGet + " /api/auth/github/start":    true,
		http.MethodGet + " /api/auth/github/callback": true,
		http.MethodPost + " /api/auth/logout":         true,
	}
	for _, expected := range expectedCoreRoutes {
		operation := harness.doc.Paths.Find(expected.Path).Operations()[expected.Method]
		key := expected.Method + " " + expected.Path
		if publicRoutes[key] {
			if operation.Security != nil {
				t.Fatalf("public route %s unexpectedly declares Workspace session security", key)
			}
			continue
		}
		if operation.Security == nil || len(*operation.Security) != 1 {
			t.Fatalf("protected route %s does not require exactly one security alternative", key)
		}
		requirement := (*operation.Security)[0]
		if len(requirement) != 1 {
			t.Fatalf("protected route %s has unexpected security requirement %#v", key, requirement)
		}
		if _, ok := requirement["workspaceSession"]; !ok {
			t.Fatalf("protected route %s does not require workspaceSession: %#v", key, requirement)
		}
	}
}

func TestNodeCoreFixturesValidateAgainstOpenAPI(t *testing.T) {
	harness := loadCoreContract(t)
	for _, scenario := range harness.fixture.Scenarios {
		t.Run(scenario.Name, func(t *testing.T) {
			input, err := routeCoreRequest(harness.router, scenario.Request)
			if err != nil {
				t.Fatalf("route fixture request: %v", err)
			}
			if err := openapi3filter.ValidateRequest(context.Background(), input); err != nil {
				t.Fatalf("Node request does not conform: %v", err)
			}
			if err := validateCoreResponse(input, scenario.Response); err != nil {
				t.Fatalf("Node response does not conform: %v", err)
			}
		})
	}
}

func TestWorkspaceCoreContractPreservesNullAndOmittedFields(t *testing.T) {
	harness := loadCoreContract(t)
	scenario := findCoreScenario(t, harness.fixture, "message-create-write")
	var envelope map[string]any
	if err := json.Unmarshal(scenario.Response.Body, &envelope); err != nil {
		t.Fatalf("decode message fixture: %v", err)
	}
	message, ok := envelope["message"].(map[string]any)
	if !ok {
		t.Fatalf("message fixture envelope = %#v", envelope["message"])
	}
	if value, exists := message["replyToMessageId"]; !exists || value != nil {
		t.Fatalf("replyToMessageId = (%#v, %t), want explicit null", value, exists)
	}
	if _, exists := message["pin"]; exists {
		t.Fatal("pin was emitted before the pin operation; omitted and null are different contract states")
	}

	input, err := routeCoreRequest(harness.router, scenario.Request)
	if err != nil {
		t.Fatal(err)
	}
	message["unknownField"] = true
	mutated, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateCoreResponseBody(input, scenario.Response.Status, mutated); err == nil {
		t.Fatal("Message schema accepted an unrecognized response field")
	}
}

type coreHarness struct {
	doc     *openapi3.T
	router  routers.Router
	fixture coreFixture
}

func loadCoreContract(t *testing.T) coreHarness {
	t.Helper()
	loader := openapi3.NewLoader()
	loader.IsExternalRefsAllowed = false
	doc, err := loader.LoadFromFile(workspaceCoreContractPath)
	if err != nil {
		t.Fatalf("load Workspace core OpenAPI: %v", err)
	}
	if doc.OpenAPI != "3.1.2" {
		t.Fatalf("OpenAPI version = %q, want 3.1.2", doc.OpenAPI)
	}
	if err := doc.Validate(context.Background()); err != nil {
		t.Fatalf("validate Workspace core OpenAPI: %v", err)
	}
	router, err := legacy.NewRouter(doc)
	if err != nil {
		t.Fatalf("build Workspace core OpenAPI router: %v", err)
	}
	fixtureBytes, err := os.ReadFile(workspaceCoreFixturePath)
	if err != nil {
		t.Fatalf("read Node Workspace core fixture: %v", err)
	}
	var fixture coreFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatalf("decode Node Workspace core fixture: %v", err)
	}
	if fixture.SchemaVersion != 1 {
		t.Fatalf("fixture schemaVersion = %d, want 1", fixture.SchemaVersion)
	}
	return coreHarness{doc: doc, router: router, fixture: fixture}
}

func loadNodeRoutes(t *testing.T) map[string]coreRoute {
	t.Helper()
	bytes, err := os.ReadFile(nodeRoutesPath)
	if err != nil {
		t.Fatalf("read Node route inventory: %v", err)
	}
	var payload struct {
		Routes []coreRoute `json:"routes"`
	}
	if err := json.Unmarshal(bytes, &payload); err != nil {
		t.Fatalf("decode Node route inventory: %v", err)
	}
	result := make(map[string]coreRoute, len(payload.Routes))
	for _, route := range payload.Routes {
		result[route.Method+" "+route.Path] = route
	}
	return result
}

func routeCoreRequest(router routers.Router, fixture fixtureRequest) (*openapi3filter.RequestValidationInput, error) {
	var body io.Reader
	if len(fixture.Body) != 0 && string(fixture.Body) != "null" {
		body = bytes.NewReader(fixture.Body)
	}
	request := httptest.NewRequest(fixture.Method, fixture.Path, body)
	for key, value := range fixture.Headers {
		request.Header.Set(key, value)
	}
	route, pathParams, err := router.FindRoute(request)
	if err != nil {
		return nil, err
	}
	return &openapi3filter.RequestValidationInput{
		Request:    request,
		PathParams: pathParams,
		Route:      route,
		Options: &openapi3filter.Options{
			AuthenticationFunc:    openapi3filter.NoopAuthenticationFunc,
			IncludeResponseStatus: true,
		},
	}, nil
}

func validateCoreResponse(input *openapi3filter.RequestValidationInput, response fixtureResponse) error {
	return validateCoreResponseBody(input, response.Status, response.Body)
}

func validateCoreResponseBody(input *openapi3filter.RequestValidationInput, status int, body []byte) error {
	validationInput := &openapi3filter.ResponseValidationInput{
		RequestValidationInput: input,
		Status:                 status,
		Header:                 http.Header{"Content-Type": []string{"application/json"}},
		Options:                input.Options,
	}
	validationInput.SetBodyBytes(body)
	return openapi3filter.ValidateResponse(context.Background(), validationInput)
}

func findCoreScenario(t *testing.T, fixture coreFixture, name string) coreScenario {
	t.Helper()
	for _, scenario := range fixture.Scenarios {
		if scenario.Name == name {
			return scenario
		}
	}
	t.Fatalf("fixture scenario %q is missing", name)
	return coreScenario{}
}

func (r coreRoute) String() string {
	return fmt.Sprintf("%s %s", r.Method, r.Path)
}
