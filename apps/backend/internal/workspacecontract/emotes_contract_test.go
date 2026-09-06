package workspacecontract

import (
	"bytes"
	"context"
	"encoding/base64"
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
	workspaceEmotesContractPath = "../../api/workspace-emotes.yaml"
	workspaceEmotesFixturePath  = "testdata/node-emotes.json"
)

type emotesFixture struct {
	SchemaVersion int             `json:"schemaVersion"`
	Source        fixtureSource   `json:"source"`
	Routes        []coreRoute     `json:"routes"`
	Scenarios     []emoteScenario `json:"scenarios"`
}

type emoteScenario struct {
	Name     string        `json:"name"`
	Request  emoteRequest  `json:"request"`
	Response emoteResponse `json:"response"`
}

type emoteRequest struct {
	Method     string            `json:"method"`
	Path       string            `json:"path"`
	Headers    map[string]string `json:"headers"`
	Body       json.RawMessage   `json:"body"`
	BodyBase64 string            `json:"bodyBase64"`
}

type emoteResponse struct {
	Status     int               `json:"status"`
	Headers    map[string]string `json:"headers"`
	Body       json.RawMessage   `json:"body"`
	BodyBase64 string            `json:"bodyBase64"`
}

var expectedEmoteRoutes = []coreRoute{
	{Method: http.MethodGet, Path: "/api/workspace/emote-collection-shares/{shareId}"},
	{Method: http.MethodPost, Path: "/api/workspace/emote-collection-shares/{shareId}/import"},
	{Method: http.MethodGet, Path: "/api/workspace/emotes/{emoteId}/content"},
	{Method: http.MethodDelete, Path: "/api/workspace/me/emote-collection-shares/{shareId}"},
	{Method: http.MethodPost, Path: "/api/workspace/me/emote-collections"},
	{Method: http.MethodDelete, Path: "/api/workspace/me/emote-collections/{collectionId}"},
	{Method: http.MethodPatch, Path: "/api/workspace/me/emote-collections/{collectionId}"},
	{Method: http.MethodPost, Path: "/api/workspace/me/emote-collections/{collectionId}/items"},
	{Method: http.MethodDelete, Path: "/api/workspace/me/emote-collections/{collectionId}/items/{emoteId}"},
	{Method: http.MethodPut, Path: "/api/workspace/me/emote-collections/{collectionId}/order"},
	{Method: http.MethodPost, Path: "/api/workspace/me/emote-collections/{collectionId}/shares"},
	{Method: http.MethodPut, Path: "/api/workspace/me/emote-collections/{collectionId}/source-subscription"},
	{Method: http.MethodGet, Path: "/api/workspace/me/emote-library"},
	{Method: http.MethodPut, Path: "/api/workspace/me/emote-library/order"},
	{Method: http.MethodGet, Path: "/api/workspace/me/emote-settings"},
	{Method: http.MethodPut, Path: "/api/workspace/me/emote-settings"},
	{Method: http.MethodGet, Path: "/api/workspace/me/emotes"},
	{Method: http.MethodPost, Path: "/api/workspace/me/emotes"},
	{Method: http.MethodPost, Path: "/api/workspace/me/emotes/favorite"},
	{Method: http.MethodPut, Path: "/api/workspace/me/emotes/order"},
	{Method: http.MethodDelete, Path: "/api/workspace/me/emotes/{emoteId}"},
	{Method: http.MethodPatch, Path: "/api/workspace/me/emotes/{emoteId}"},
}

func TestWorkspaceEmoteContractRouteInventory(t *testing.T) {
	harness := loadEmoteContract(t)
	if len(harness.fixture.Routes) != len(expectedEmoteRoutes) {
		t.Fatalf("fixture route count = %d, want %d", len(harness.fixture.Routes), len(expectedEmoteRoutes))
	}
	for _, expected := range expectedEmoteRoutes {
		key := expected.Method + " " + expected.Path
		fixtureRoute := findEmoteRoute(t, harness.fixture.Routes, key)
		nodeRoute, ok := loadNodeRoutes(t)[key]
		if !ok {
			t.Fatalf("node-routes.json is missing %s", key)
		}
		if fixtureRoute.NodePath != nodeRoute.NodePath || fixtureRoute.Source != nodeRoute.Source {
			t.Fatalf("fixture route %s = %#v, want Node inventory %#v", key, fixtureRoute, nodeRoute)
		}
		pathItem := harness.doc.Paths.Find(expected.Path)
		if pathItem == nil || pathItem.Operations()[expected.Method] == nil {
			t.Fatalf("OpenAPI is missing emote operation %s", key)
		}
	}

	for key, route := range loadNodeRoutes(t) {
		if strings.Contains(route.Path, "/emote") && !isExpectedEmoteRoute(key) {
			t.Fatalf("Node emote route %s is missing from this contract", key)
		}
	}
}

func TestWorkspaceEmoteFixturesValidateAgainstOpenAPI(t *testing.T) {
	harness := loadEmoteContract(t)
	if len(harness.fixture.Scenarios) < 30 {
		t.Fatalf("fixture has only %d scenarios; expected a real route/error matrix", len(harness.fixture.Scenarios))
	}
	seen := make(map[string]bool)
	for _, scenario := range harness.fixture.Scenarios {
		scenario := scenario
		t.Run(scenario.Name, func(t *testing.T) {
			input, err := routeEmoteRequest(harness.router, scenario.Request)
			if err != nil {
				t.Fatalf("route fixture request: %v", err)
			}
			seen[emoteRouteTemplate(scenario.Request.Method, scenario.Request.Path)] = true
			if err := openapi3filter.ValidateRequest(context.Background(), input); err != nil {
				t.Fatalf("Node request does not conform: %v", err)
			}
			if err := validateEmoteResponse(input, scenario.Response); err != nil {
				t.Fatalf("Node response does not conform: %v", err)
			}
			if scenario.Response.Status == http.StatusOK && scenario.Response.BodyBase64 != "" {
				decoded, err := base64.StdEncoding.DecodeString(scenario.Response.BodyBase64)
				if err != nil || len(decoded) == 0 {
					t.Fatalf("successful binary response is empty or invalid base64")
				}
			}
		})
	}
	for _, expected := range expectedEmoteRoutes {
		key := expected.Method + " " + expected.Path
		if !seen[key] {
			t.Fatalf("fixture has no scenario for %s", key)
		}
	}
}

func TestWorkspaceEmoteSchemasRejectUnknownDTOFields(t *testing.T) {
	harness := loadEmoteContract(t)
	scenario := findEmoteScenario(t, "custom-upload")
	input, err := routeEmoteRequest(harness.router, scenario.Request)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(scenario.Response.Body, &body); err != nil {
		t.Fatal(err)
	}
	emote := body["emote"].(map[string]any)
	emote["unexpectedField"] = true
	mutated, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	mutatedResponse := scenario.Response
	mutatedResponse.Body = mutated
	if err := validateEmoteResponse(input, mutatedResponse); err == nil {
		t.Fatal("Emote schema accepted an unrecognized DTO field")
	}
}

type emoteHarness struct {
	doc     *openapi3.T
	router  routers.Router
	fixture emotesFixture
}

func loadEmoteContract(t *testing.T) emoteHarness {
	t.Helper()
	loader := openapi3.NewLoader()
	loader.IsExternalRefsAllowed = false
	doc, err := loader.LoadFromFile(workspaceEmotesContractPath)
	if err != nil {
		t.Fatalf("load Workspace emotes OpenAPI: %v", err)
	}
	if doc.OpenAPI != "3.1.2" {
		t.Fatalf("OpenAPI version = %q, want 3.1.2", doc.OpenAPI)
	}
	if err := doc.Validate(context.Background()); err != nil {
		t.Fatalf("validate Workspace emotes OpenAPI: %v", err)
	}
	router, err := legacy.NewRouter(doc)
	if err != nil {
		t.Fatalf("build Workspace emotes OpenAPI router: %v", err)
	}
	fixtureBytes, err := os.ReadFile(workspaceEmotesFixturePath)
	if err != nil {
		t.Fatalf("read Node Workspace emotes fixture: %v", err)
	}
	var fixture emotesFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatalf("decode Node Workspace emotes fixture: %v", err)
	}
	if fixture.SchemaVersion != 1 {
		t.Fatalf("fixture schemaVersion = %d, want 1", fixture.SchemaVersion)
	}
	return emoteHarness{doc: doc, router: router, fixture: fixture}
}

func routeEmoteRequest(router routers.Router, fixture emoteRequest) (*openapi3filter.RequestValidationInput, error) {
	var body io.Reader
	if fixture.BodyBase64 != "" {
		decoded, err := base64.StdEncoding.DecodeString(fixture.BodyBase64)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(decoded)
	} else if len(fixture.Body) != 0 && string(fixture.Body) != "null" {
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

func validateEmoteResponse(input *openapi3filter.RequestValidationInput, response emoteResponse) error {
	header := make(http.Header)
	for key, value := range response.Headers {
		header.Set(key, value)
	}
	if header.Get("Content-Type") == "" {
		if response.BodyBase64 != "" {
			header.Set("Content-Type", "application/octet-stream")
		} else {
			header.Set("Content-Type", "application/json")
		}
	}
	validationInput := &openapi3filter.ResponseValidationInput{
		RequestValidationInput: input,
		Status:                 response.Status,
		Header:                 header,
		Options:                input.Options,
	}
	if response.BodyBase64 != "" {
		body, err := base64.StdEncoding.DecodeString(response.BodyBase64)
		if err != nil {
			return err
		}
		validationInput.SetBodyBytes(body)
	} else {
		validationInput.SetBodyBytes(response.Body)
	}
	return openapi3filter.ValidateResponse(context.Background(), validationInput)
}

func findEmoteRoute(t *testing.T, routes []coreRoute, key string) coreRoute {
	t.Helper()
	for _, route := range routes {
		if route.Method+" "+route.Path == key {
			return route
		}
	}
	t.Fatalf("fixture route %s is missing", key)
	return coreRoute{}
}

func isExpectedEmoteRoute(key string) bool {
	for _, expected := range expectedEmoteRoutes {
		if expected.Method+" "+expected.Path == key {
			return true
		}
	}
	return false
}

func findEmoteScenario(t *testing.T, name string) emoteScenario {
	t.Helper()
	fixture := loadEmoteContract(t).fixture
	for _, scenario := range fixture.Scenarios {
		if scenario.Name == name {
			return scenario
		}
	}
	t.Fatalf("fixture scenario %q is missing", name)
	return emoteScenario{}
}

func emoteRouteTemplate(method, requestPath string) string {
	requestPath = strings.SplitN(requestPath, "?", 2)[0]
	requestParts := strings.Split(strings.Trim(requestPath, "/"), "/")
	for _, expected := range expectedEmoteRoutes {
		if expected.Method != method {
			continue
		}
		templateParts := strings.Split(strings.Trim(expected.Path, "/"), "/")
		if len(templateParts) != len(requestParts) {
			continue
		}
		matches := true
		for index := range templateParts {
			if strings.HasPrefix(templateParts[index], "{") && strings.HasSuffix(templateParts[index], "}") {
				if requestParts[index] == "" {
					matches = false
				}
				continue
			}
			if templateParts[index] != requestParts[index] {
				matches = false
				break
			}
		}
		if matches {
			return expected.Method + " " + expected.Path
		}
	}
	return "unknown"
}
