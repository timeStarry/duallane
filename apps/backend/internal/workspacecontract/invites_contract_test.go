package workspacecontract

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers"
	"github.com/getkin/kin-openapi/routers/legacy"
)

const (
	workspaceInvitesContractPath = "../../api/workspace-invites.yaml"
	workspaceInvitesFixturePath  = "testdata/node-invites.json"
)

type invitesFixture struct {
	SchemaVersion int               `json:"schemaVersion"`
	Source        invitesSource     `json:"source"`
	Routes        []invitesRoute    `json:"routes"`
	Scenarios     []invitesScenario `json:"scenarios"`
}

type invitesSource struct {
	NodeRoutes     string `json:"nodeRoutes"`
	RouteSource    string `json:"routeSource"`
	FixtureRuntime string `json:"fixtureRuntime"`
}

type invitesRoute struct {
	Method   string `json:"method"`
	Path     string `json:"path"`
	NodePath string `json:"nodePath"`
	Source   string `json:"source"`
}

type invitesScenario struct {
	Name        string          `json:"name"`
	Request     invitesRequest  `json:"request"`
	Response    invitesResponse `json:"response"`
	SideEffects json.RawMessage `json:"sideEffects"`
}

type invitesRequest struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    json.RawMessage   `json:"body"`
}

type invitesResponse struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    json.RawMessage   `json:"body"`
}

var expectedInvitesRoutes = []invitesRoute{
	{Method: http.MethodPost, Path: "/api/workspace/invites"},
	{Method: http.MethodPost, Path: "/api/workspace/invites/{code}/accept"},
	{Method: http.MethodPost, Path: "/api/workspace/invites/{inviteId}/revoke"},
}

func TestWorkspaceInvitesContractRouteInventory(t *testing.T) {
	harness := loadInvitesContract(t)
	if got, want := len(harness.fixture.Routes), len(expectedInvitesRoutes); got != want {
		t.Fatalf("fixture route count = %d, want %d", got, want)
	}
	nodeRoutes := loadInvitesNodeRoutes(t)
	for _, expected := range expectedInvitesRoutes {
		key := expected.Method + " " + expected.Path
		fixtureRoute := findInvitesRoute(t, harness.fixture.Routes, key)
		nodeRoute, ok := nodeRoutes[key]
		if !ok {
			t.Fatalf("node-routes.json is missing %s", key)
		}
		if fixtureRoute.NodePath != nodeRoute.NodePath || fixtureRoute.Source != nodeRoute.Source {
			t.Fatalf("fixture route %s = %#v, want %#v", key, fixtureRoute, nodeRoute)
		}
		pathItem := harness.doc.Paths.Find(expected.Path)
		if pathItem == nil || pathItem.Operations()[expected.Method] == nil {
			t.Fatalf("OpenAPI is missing invite operation %s", key)
		}
		operation := pathItem.Operations()[expected.Method]
		if expected.Path == "/api/workspace/invites/{code}/accept" {
			if operation.Security != nil {
				t.Fatalf("invite acceptance unexpectedly requires a session")
			}
			continue
		}
		if operation.Security == nil || len(*operation.Security) != 1 || len((*operation.Security)[0]) != 1 {
			t.Fatalf("invite operation %s does not require exactly one session security scheme", key)
		}
		if _, ok := (*operation.Security)[0]["workspaceSession"]; !ok {
			t.Fatalf("invite operation %s has unexpected security %#v", key, *operation.Security)
		}
	}
}

func TestWorkspaceInvitesFixturesValidateAgainstOpenAPI(t *testing.T) {
	harness := loadInvitesContract(t)
	if got, want := len(harness.fixture.Scenarios), 4; got != want {
		t.Fatalf("Node invite fixture scenario count = %d, want %d", got, want)
	}
	seen := make(map[string]bool)
	for _, scenario := range harness.fixture.Scenarios {
		scenario := scenario
		t.Run(scenario.Name, func(t *testing.T) {
			input, err := routeInvitesRequest(harness.router, scenario.Request)
			if err != nil {
				t.Fatalf("route fixture request: %v", err)
			}
			seen[invitesRouteTemplate(scenario.Request.Method, scenario.Request.Path)] = true
			if err := openapi3filter.ValidateRequest(context.Background(), input); err != nil {
				t.Fatalf("Node request does not conform: %v", err)
			}
			if err := validateInvitesResponse(input, scenario.Response); err != nil {
				t.Fatalf("Node response does not conform: %v", err)
			}
		})
	}
	for _, expected := range expectedInvitesRoutes {
		key := expected.Method + " " + expected.Path
		if !seen[key] {
			t.Fatalf("fixture has no scenario for %s", key)
		}
	}
}

func TestWorkspaceInvitesSchemasRejectUnknownFieldsAndPreserveOneTimeCodeBoundary(t *testing.T) {
	harness := loadInvitesContract(t)
	scenario := findInvitesScenario(t, "create-member-invite")
	input, err := routeInvitesRequest(harness.router, scenario.Request)
	if err != nil {
		t.Fatal(err)
	}
	var requestBody map[string]any
	if err := json.Unmarshal(scenario.Request.Body, &requestBody); err != nil {
		t.Fatal(err)
	}
	requestBody["unexpectedField"] = true
	requestBytes, err := json.Marshal(requestBody)
	if err != nil {
		t.Fatal(err)
	}
	request := *input.Request
	request.Body = io.NopCloser(bytes.NewReader(requestBytes))
	input.Request = &request
	if err := openapi3filter.ValidateRequest(context.Background(), input); err == nil {
		t.Fatal("invite create request accepted an unrecognized field")
	}

	var inviteEnvelope map[string]any
	if err := json.Unmarshal(scenario.Response.Body, &inviteEnvelope); err != nil {
		t.Fatal(err)
	}
	invite := inviteEnvelope["invite"].(map[string]any)
	if _, ok := invite["code"].(string); !ok {
		t.Fatal("creation response did not carry the raw code")
	}
	revoked := findInvitesScenario(t, "revoke-invite")
	var revokedEnvelope map[string]any
	if err := json.Unmarshal(revoked.Response.Body, &revokedEnvelope); err != nil {
		t.Fatal(err)
	}
	if _, ok := revokedEnvelope["invite"].(map[string]any)["code"]; ok {
		t.Fatal("revocation response exposed the one-time raw invite code")
	}
}

func TestWorkspaceInvitesMutationFixturesCarryAuditRecords(t *testing.T) {
	for _, name := range []string{"create-member-invite", "accept-invite", "revoke-invite"} {
		scenario := findInvitesScenario(t, name)
		if len(scenario.SideEffects) == 0 {
			t.Fatalf("%s omitted side effects", name)
		}
		var effects struct {
			Audit struct {
				Action string `json:"action"`
				Result string `json:"result"`
			} `json:"audit"`
		}
		if err := json.Unmarshal(scenario.SideEffects, &effects); err != nil {
			t.Fatalf("decode %s side effects: %v", name, err)
		}
		if effects.Audit.Action == "" || effects.Audit.Result == "" {
			t.Fatalf("%s audit = %#v", name, effects.Audit)
		}
	}
}

type invitesHarness struct {
	doc     *openapi3.T
	router  routers.Router
	fixture invitesFixture
}

func loadInvitesContract(t *testing.T) invitesHarness {
	t.Helper()
	loader := openapi3.NewLoader()
	loader.IsExternalRefsAllowed = false
	doc, err := loader.LoadFromFile(workspaceInvitesContractPath)
	if err != nil {
		t.Fatalf("load Workspace invites OpenAPI: %v", err)
	}
	if doc.OpenAPI != "3.1.2" {
		t.Fatalf("OpenAPI version = %q, want 3.1.2", doc.OpenAPI)
	}
	if err := doc.Validate(context.Background()); err != nil {
		t.Fatalf("validate Workspace invites OpenAPI: %v", err)
	}
	router, err := legacy.NewRouter(doc)
	if err != nil {
		t.Fatalf("build Workspace invites OpenAPI router: %v", err)
	}
	fixtureBytes, err := os.ReadFile(workspaceInvitesFixturePath)
	if err != nil {
		t.Fatalf("read Node Workspace invites fixture: %v", err)
	}
	var fixture invitesFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatalf("decode Node Workspace invites fixture: %v", err)
	}
	if fixture.SchemaVersion != 1 {
		t.Fatalf("fixture schemaVersion = %d, want 1", fixture.SchemaVersion)
	}
	if fixture.Source.NodeRoutes != "apps/backend/api/node-routes.json" || fixture.Source.RouteSource != "apps/web/server/index.mjs" {
		t.Fatalf("fixture source is not traceable: %#v", fixture.Source)
	}
	return invitesHarness{doc: doc, router: router, fixture: fixture}
}

func loadInvitesNodeRoutes(t *testing.T) map[string]invitesRoute {
	t.Helper()
	data, err := os.ReadFile("../../api/node-routes.json")
	if err != nil {
		t.Fatalf("read Node route inventory: %v", err)
	}
	var payload struct {
		Routes []invitesRoute `json:"routes"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatalf("decode Node route inventory: %v", err)
	}
	result := make(map[string]invitesRoute, len(payload.Routes))
	for _, route := range payload.Routes {
		result[route.Method+" "+route.Path] = route
	}
	return result
}

func findInvitesRoute(t *testing.T, routes []invitesRoute, key string) invitesRoute {
	t.Helper()
	for _, route := range routes {
		if route.Method+" "+route.Path == key {
			return route
		}
	}
	t.Fatalf("fixture route %s not found", key)
	return invitesRoute{}
}

func findInvitesScenario(t *testing.T, name string) invitesScenario {
	t.Helper()
	fixture := loadInvitesContract(t).fixture
	for _, scenario := range fixture.Scenarios {
		if scenario.Name == name {
			return scenario
		}
	}
	t.Fatalf("fixture scenario %q not found", name)
	return invitesScenario{}
}

func routeInvitesRequest(router routers.Router, fixture invitesRequest) (*openapi3filter.RequestValidationInput, error) {
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

func validateInvitesResponse(input *openapi3filter.RequestValidationInput, fixture invitesResponse) error {
	header := make(http.Header)
	for key, value := range fixture.Headers {
		header.Set(key, value)
	}
	if header.Get("Content-Type") == "" {
		header.Set("Content-Type", "application/json")
	}
	validationInput := &openapi3filter.ResponseValidationInput{
		RequestValidationInput: input,
		Status:                 fixture.Status,
		Header:                 header,
		Options:                input.Options,
	}
	validationInput.SetBodyBytes(fixture.Body)
	return openapi3filter.ValidateResponse(context.Background(), validationInput)
}

func invitesRouteTemplate(method, path string) string {
	if strings.HasPrefix(path, "/api/workspace/invites/INVITE-CONTRACT-MEMBER/accept") {
		return method + " /api/workspace/invites/{code}/accept"
	}
	if strings.HasPrefix(path, "/api/workspace/invites/inv_generated/revoke") {
		return method + " /api/workspace/invites/{inviteId}/revoke"
	}
	return method + " " + path
}
