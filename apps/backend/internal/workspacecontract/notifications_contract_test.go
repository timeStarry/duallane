package workspacecontract

import (
	"bytes"
	"context"
	"encoding/json"
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
	workspaceNotificationsContractPath = "../../api/workspace-notifications.yaml"
	workspaceNotificationsFixturePath  = "testdata/node-notifications.json"
)

type notificationsFixture struct {
	SchemaVersion int                     `json:"schemaVersion"`
	Source        notificationsSource     `json:"source"`
	Routes        []notificationsRoute    `json:"routes"`
	Scenarios     []notificationsScenario `json:"scenarios"`
}

type notificationsSource struct {
	NodeRoutes     string `json:"nodeRoutes"`
	RouteSource    string `json:"routeSource"`
	FixtureRuntime string `json:"fixtureRuntime"`
}

type notificationsRoute struct {
	Method   string `json:"method"`
	Path     string `json:"path"`
	NodePath string `json:"nodePath"`
	Source   string `json:"source"`
}

type notificationsScenario struct {
	Name        string                `json:"name"`
	Request     notificationsRequest  `json:"request"`
	Response    notificationsResponse `json:"response"`
	SideEffects json.RawMessage       `json:"sideEffects"`
}

type notificationsRequest struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    json.RawMessage   `json:"body"`
}

type notificationsResponse struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    json.RawMessage   `json:"body"`
}

var expectedNotificationsRoutes = []notificationsRoute{
	{Method: http.MethodPost, Path: "/api/workspace/me/notification-email/challenges"},
	{Method: http.MethodPost, Path: "/api/workspace/me/notification-email/use-github"},
	{Method: http.MethodPost, Path: "/api/workspace/me/notification-email/verify"},
	{Method: http.MethodGet, Path: "/api/workspace/me/notifications"},
	{Method: http.MethodPatch, Path: "/api/workspace/me/notifications"},
	{Method: http.MethodGet, Path: "/api/workspace/me/ntfy"},
	{Method: http.MethodPatch, Path: "/api/workspace/me/ntfy"},
	{Method: http.MethodPost, Path: "/api/workspace/me/ntfy/rotate"},
	{Method: http.MethodGet, Path: "/api/workspace/settings/email"},
	{Method: http.MethodPut, Path: "/api/workspace/settings/email"},
	{Method: http.MethodPost, Path: "/api/workspace/settings/email/test"},
}

func TestWorkspaceNotificationsContractRouteInventory(t *testing.T) {
	harness := loadNotificationsContract(t)
	if got, want := len(harness.fixture.Routes), len(expectedNotificationsRoutes); got != want {
		t.Fatalf("fixture route count = %d, want %d", got, want)
	}
	nodeRoutes := loadNotificationsNodeRoutes(t)
	for _, expected := range expectedNotificationsRoutes {
		key := expected.Method + " " + expected.Path
		fixtureRoute := findNotificationsRoute(t, harness.fixture.Routes, key)
		nodeRoute, ok := nodeRoutes[key]
		if !ok {
			t.Fatalf("node-routes.json is missing %s", key)
		}
		if fixtureRoute.NodePath != nodeRoute.NodePath || fixtureRoute.Source != nodeRoute.Source {
			t.Fatalf("fixture route %s = %#v, want %#v", key, fixtureRoute, nodeRoute)
		}
		pathItem := harness.doc.Paths.Find(expected.Path)
		if pathItem == nil || pathItem.Operations()[expected.Method] == nil {
			t.Fatalf("OpenAPI is missing notification operation %s", key)
		}
		operation := pathItem.Operations()[expected.Method]
		if operation.Security == nil || len(*operation.Security) != 1 || len((*operation.Security)[0]) != 1 {
			t.Fatalf("notification operation %s does not require exactly one session security scheme", key)
		}
		if _, ok := (*operation.Security)[0]["workspaceSession"]; !ok {
			t.Fatalf("notification operation %s has unexpected security %#v", key, *operation.Security)
		}
	}
}

func TestWorkspaceNotificationsFixturesValidateAgainstOpenAPI(t *testing.T) {
	harness := loadNotificationsContract(t)
	if got, want := len(harness.fixture.Scenarios), 14; got != want {
		t.Fatalf("Node notifications fixture scenario count = %d, want %d", got, want)
	}
	seen := make(map[string]bool)
	for _, scenario := range harness.fixture.Scenarios {
		scenario := scenario
		t.Run(scenario.Name, func(t *testing.T) {
			input, err := routeNotificationsRequest(harness.router, scenario.Request)
			if err != nil {
				t.Fatalf("route fixture request: %v", err)
			}
			seen[scenario.Request.Method+" "+scenario.Request.Path] = true
			if err := openapi3filter.ValidateRequest(context.Background(), input); err != nil {
				t.Fatalf("Node request does not conform: %v", err)
			}
			if err := validateNotificationsResponse(input, scenario.Response); err != nil {
				t.Fatalf("Node response does not conform: %v", err)
			}
		})
	}
	for _, expected := range expectedNotificationsRoutes {
		key := expected.Method + " " + expected.Path
		found := false
		for scenarioKey := range seen {
			if scenarioKey == key {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("fixture has no scenario for %s", key)
		}
	}
}

func TestWorkspaceNotificationsSchemasRejectUnknownFieldsAndPreserveNullableStates(t *testing.T) {
	harness := loadNotificationsContract(t)
	scenario := findNotificationsScenario(t, "notifications-patch")
	input, err := routeNotificationsRequest(harness.router, scenario.Request)
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
		t.Fatal("notification patch accepted an unrecognized field")
	}

	ntfy := findNotificationsScenario(t, "ntfy-get")
	var ntfyEnvelope map[string]any
	if err := json.Unmarshal(ntfy.Response.Body, &ntfyEnvelope); err != nil {
		t.Fatal(err)
	}
	if value, ok := ntfyEnvelope["ntfy"].(map[string]any)["rotatedAt"]; !ok || value != nil {
		t.Fatalf("initial ntfy rotatedAt = (%#v, %t), want explicit null", value, ok)
	}
	initialEmail := findNotificationsScenario(t, "email-settings-get-before-config")
	var emailEnvelope map[string]any
	if err := json.Unmarshal(initialEmail.Response.Body, &emailEnvelope); err != nil {
		t.Fatal(err)
	}
	settings := emailEnvelope["settings"].(map[string]any)
	for _, secretField := range []string{"password", "passwordCiphertext", "testProof"} {
		if _, ok := settings[secretField]; ok {
			t.Fatalf("unconfigured SMTP settings exposed %q", secretField)
		}
	}
	if _, ok := settings["activeFrom"]; ok {
		t.Fatal("unconfigured SMTP settings unexpectedly emitted activeFrom")
	}
	if _, ok := settings["updatedAt"]; ok {
		t.Fatal("unconfigured SMTP settings unexpectedly emitted updatedAt")
	}
	configured := findNotificationsScenario(t, "email-settings-get")
	var configuredEnvelope map[string]any
	if err := json.Unmarshal(configured.Response.Body, &configuredEnvelope); err != nil {
		t.Fatal(err)
	}
	configuredSettings := configuredEnvelope["settings"].(map[string]any)
	for _, secretField := range []string{"password", "passwordCiphertext", "testProof"} {
		if _, ok := configuredSettings[secretField]; ok {
			t.Fatalf("configured SMTP settings exposed %q", secretField)
		}
	}

	responseScenario := findNotificationsScenario(t, "notifications-patch")
	var responseEnvelope map[string]any
	if err := json.Unmarshal(responseScenario.Response.Body, &responseEnvelope); err != nil {
		t.Fatal(err)
	}
	responseEnvelope["unexpectedField"] = true
	mutated, err := json.Marshal(responseEnvelope)
	if err != nil {
		t.Fatal(err)
	}
	responseScenario.Response.Body = mutated
	if err := validateNotificationsResponse(input, responseScenario.Response); err == nil {
		t.Fatal("notification response accepted an unrecognized field")
	}
}

func TestWorkspaceNotificationsEmailMutationFixturesCarryAuditRecords(t *testing.T) {
	for _, name := range []string{"email-settings-test", "email-settings-put", "email-challenge-create", "email-challenge-verify"} {
		scenario := findNotificationsScenario(t, name)
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

type notificationsHarness struct {
	doc     *openapi3.T
	router  routers.Router
	fixture notificationsFixture
}

func loadNotificationsContract(t *testing.T) notificationsHarness {
	t.Helper()
	loader := openapi3.NewLoader()
	loader.IsExternalRefsAllowed = false
	doc, err := loader.LoadFromFile(workspaceNotificationsContractPath)
	if err != nil {
		t.Fatalf("load Workspace notifications OpenAPI: %v", err)
	}
	if doc.OpenAPI != "3.1.2" {
		t.Fatalf("OpenAPI version = %q, want 3.1.2", doc.OpenAPI)
	}
	if err := doc.Validate(context.Background()); err != nil {
		t.Fatalf("validate Workspace notifications OpenAPI: %v", err)
	}
	router, err := legacy.NewRouter(doc)
	if err != nil {
		t.Fatalf("build Workspace notifications OpenAPI router: %v", err)
	}
	fixtureBytes, err := os.ReadFile(workspaceNotificationsFixturePath)
	if err != nil {
		t.Fatalf("read Node Workspace notifications fixture: %v", err)
	}
	var fixture notificationsFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatalf("decode Node Workspace notifications fixture: %v", err)
	}
	if fixture.SchemaVersion != 1 {
		t.Fatalf("fixture schemaVersion = %d, want 1", fixture.SchemaVersion)
	}
	if fixture.Source.NodeRoutes != "apps/backend/api/node-routes.json" || fixture.Source.RouteSource != "apps/web/server/index.mjs" {
		t.Fatalf("fixture source is not traceable: %#v", fixture.Source)
	}
	return notificationsHarness{doc: doc, router: router, fixture: fixture}
}

func loadNotificationsNodeRoutes(t *testing.T) map[string]notificationsRoute {
	t.Helper()
	data, err := os.ReadFile("../../api/node-routes.json")
	if err != nil {
		t.Fatalf("read Node route inventory: %v", err)
	}
	var payload struct {
		Routes []notificationsRoute `json:"routes"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatalf("decode Node route inventory: %v", err)
	}
	result := make(map[string]notificationsRoute, len(payload.Routes))
	for _, route := range payload.Routes {
		result[route.Method+" "+route.Path] = route
	}
	return result
}

func findNotificationsRoute(t *testing.T, routes []notificationsRoute, key string) notificationsRoute {
	t.Helper()
	for _, route := range routes {
		if route.Method+" "+route.Path == key {
			return route
		}
	}
	t.Fatalf("fixture route %s not found", key)
	return notificationsRoute{}
}

func findNotificationsScenario(t *testing.T, name string) notificationsScenario {
	t.Helper()
	fixture := loadNotificationsContract(t).fixture
	for _, scenario := range fixture.Scenarios {
		if scenario.Name == name {
			return scenario
		}
	}
	t.Fatalf("fixture scenario %q not found", name)
	return notificationsScenario{}
}

func routeNotificationsRequest(router routers.Router, fixture notificationsRequest) (*openapi3filter.RequestValidationInput, error) {
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

func validateNotificationsResponse(input *openapi3filter.RequestValidationInput, fixture notificationsResponse) error {
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
