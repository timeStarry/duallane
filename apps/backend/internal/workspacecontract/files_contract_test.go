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
	"regexp"
	"strings"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers"
	"github.com/getkin/kin-openapi/routers/legacy"
)

const (
	workspaceFilesContractPath = "../../api/workspace-files.yaml"
	workspaceFilesFixturePath  = "testdata/node-files.json"
)

type filesFixture struct {
	SchemaVersion int             `json:"schemaVersion"`
	Source        filesSource     `json:"source"`
	Routes        []filesRoute    `json:"routes"`
	Scenarios     []filesScenario `json:"scenarios"`
}

type filesSource struct {
	NodeRoutes     string `json:"nodeRoutes"`
	RouteSource    string `json:"routeSource"`
	FixtureRuntime string `json:"fixtureRuntime"`
}

type filesRoute struct {
	Method   string `json:"method"`
	Path     string `json:"path"`
	NodePath string `json:"nodePath"`
	Source   string `json:"source"`
}

type filesScenario struct {
	Name        string          `json:"name"`
	Request     filesRequest    `json:"request"`
	Response    filesResponse   `json:"response"`
	SideEffects json.RawMessage `json:"sideEffects"`
}

type filesRequest struct {
	Method     string            `json:"method"`
	Path       string            `json:"path"`
	Headers    map[string]string `json:"headers"`
	Body       json.RawMessage   `json:"body"`
	BodyBase64 string            `json:"bodyBase64"`
}

type filesResponse struct {
	Status     int               `json:"status"`
	Headers    map[string]string `json:"headers"`
	Body       json.RawMessage   `json:"body"`
	BodyBase64 string            `json:"bodyBase64"`
}

var expectedFilesRoutes = []filesRoute{
	{Method: http.MethodGet, Path: "/api/workspace/files"},
	{Method: http.MethodPost, Path: "/api/workspace/files/uploads/reserve"},
	{Method: http.MethodGet, Path: "/api/workspace/files/uploads/{uploadId}"},
	{Method: http.MethodPut, Path: "/api/workspace/files/uploads/{uploadId}/parts/{partNumber}"},
	{Method: http.MethodPost, Path: "/api/workspace/files/uploads/{uploadId}/complete"},
	{Method: http.MethodPut, Path: "/api/workspace/files/uploads/{uploadId}/content"},
	{Method: http.MethodPost, Path: "/api/workspace/files/uploads/{uploadId}/fail"},
	{Method: http.MethodDelete, Path: "/api/workspace/files/{attachmentId}"},
	{Method: http.MethodGet, Path: "/api/workspace/files/{attachmentId}/download"},
	{Method: http.MethodPost, Path: "/api/workspace/files/{attachmentId}/downloads/reserve"},
	{Method: http.MethodGet, Path: "/api/workspace/files/{attachmentId}/preview"},
}

func TestWorkspaceFilesContractRouteInventory(t *testing.T) {
	harness := loadFilesContract(t)
	if got, want := len(harness.fixture.Routes), len(expectedFilesRoutes); got != want {
		t.Fatalf("fixture route count = %d, want %d", got, want)
	}
	nodeRoutes := loadFilesNodeRoutes(t)
	for _, expected := range expectedFilesRoutes {
		key := expected.Method + " " + expected.Path
		fixtureRoute := findFilesRoute(t, harness.fixture.Routes, key)
		nodeRoute, ok := nodeRoutes[key]
		if !ok {
			t.Fatalf("node-routes.json is missing %s", key)
		}
		if fixtureRoute.NodePath != nodeRoute.NodePath || fixtureRoute.Source != nodeRoute.Source {
			t.Fatalf("fixture route %s = %#v, want %#v", key, fixtureRoute, nodeRoute)
		}
		pathItem := harness.doc.Paths.Find(expected.Path)
		if pathItem == nil || pathItem.Operations()[expected.Method] == nil {
			t.Fatalf("OpenAPI is missing files operation %s", key)
		}
		operation := pathItem.Operations()[expected.Method]
		if operation.Security == nil || len(*operation.Security) != 1 || len((*operation.Security)[0]) != 1 {
			t.Fatalf("files operation %s does not require exactly one session security scheme", key)
		}
		if _, ok := (*operation.Security)[0]["workspaceSession"]; !ok {
			t.Fatalf("files operation %s has unexpected security %#v", key, *operation.Security)
		}
	}
}

func TestWorkspaceFilesFixturesValidateAgainstOpenAPI(t *testing.T) {
	harness := loadFilesContract(t)
	if got, want := len(harness.fixture.Scenarios), 16; got != want {
		t.Fatalf("Node files fixture scenario count = %d, want %d", got, want)
	}
	seen := make(map[string]bool)
	for _, scenario := range harness.fixture.Scenarios {
		scenario := scenario
		t.Run(scenario.Name, func(t *testing.T) {
			input, err := routeFilesRequest(harness.router, scenario.Request)
			if err != nil {
				t.Fatalf("route fixture request: %v", err)
			}
			seen[filesRouteTemplate(scenario.Request.Method, scenario.Request.Path)] = true
			if err := openapi3filter.ValidateRequest(context.Background(), input); err != nil {
				t.Fatalf("Node request does not conform: %v", err)
			}
			if err := validateFilesResponse(input, scenario.Response); err != nil {
				t.Fatalf("Node response does not conform: %v", err)
			}
		})
	}
	for _, expected := range expectedFilesRoutes {
		key := expected.Method + " " + expected.Path
		if !seen[key] {
			t.Fatalf("fixture has no scenario for %s", key)
		}
	}
}

func TestWorkspaceFilesSchemasRejectUnknownFields(t *testing.T) {
	harness := loadFilesContract(t)
	scenario := findFilesScenario(t, "upload-reserve")
	input, err := routeFilesRequest(harness.router, scenario.Request)
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
		t.Fatal("upload reservation request accepted an unrecognized field")
	}

	responseBody := map[string]any{}
	if err := json.Unmarshal(scenario.Response.Body, &responseBody); err != nil {
		t.Fatal(err)
	}
	responseBody["unexpectedField"] = true
	mutated, err := json.Marshal(responseBody)
	if err != nil {
		t.Fatal(err)
	}
	response := scenario.Response
	response.Body = mutated
	if err := validateFilesResponse(input, response); err == nil {
		t.Fatal("upload reservation response accepted an unrecognized field")
	}
}

func TestWorkspaceFilesPreserveNullFieldsAndMutationAudit(t *testing.T) {
	harness := loadFilesContract(t)
	reserve := findFilesScenario(t, "upload-reserve")
	var envelope map[string]any
	if err := json.Unmarshal(reserve.Response.Body, &envelope); err != nil {
		t.Fatal(err)
	}
	attachment := envelope["attachment"].(map[string]any)
	if value, ok := attachment["conversationId"]; !ok || value != nil {
		t.Fatalf("pending conversationId = (%#v, %t), want explicit null", value, ok)
	}
	if value, ok := attachment["completedAt"]; !ok || value != nil {
		t.Fatalf("pending completedAt = (%#v, %t), want explicit null", value, ok)
	}
	for _, name := range []string{"upload-reserve", "upload-content-and-complete", "file-remove", "upload-fail"} {
		scenario := findFilesScenario(t, name)
		if len(scenario.SideEffects) == 0 {
			t.Fatalf("%s omitted mutation side effects", name)
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
			t.Fatalf("%s audit side effect = %#v", name, effects.Audit)
		}
	}

	input, err := routeFilesRequest(harness.router, findFilesScenario(t, "upload-reserve").Request)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateFilesResponse(input, findFilesScenario(t, "upload-reserve").Response); err != nil {
		t.Fatal(err)
	}
}

type filesHarness struct {
	doc     *openapi3.T
	router  routers.Router
	fixture filesFixture
}

func loadFilesContract(t *testing.T) filesHarness {
	t.Helper()
	loader := openapi3.NewLoader()
	loader.IsExternalRefsAllowed = false
	doc, err := loader.LoadFromFile(workspaceFilesContractPath)
	if err != nil {
		t.Fatalf("load Workspace files OpenAPI: %v", err)
	}
	if doc.OpenAPI != "3.1.2" {
		t.Fatalf("OpenAPI version = %q, want 3.1.2", doc.OpenAPI)
	}
	if err := doc.Validate(context.Background()); err != nil {
		t.Fatalf("validate Workspace files OpenAPI: %v", err)
	}
	router, err := legacy.NewRouter(doc)
	if err != nil {
		t.Fatalf("build Workspace files OpenAPI router: %v", err)
	}
	fixtureBytes, err := os.ReadFile(workspaceFilesFixturePath)
	if err != nil {
		t.Fatalf("read Node Workspace files fixture: %v", err)
	}
	var fixture filesFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatalf("decode Node Workspace files fixture: %v", err)
	}
	if fixture.SchemaVersion != 1 {
		t.Fatalf("fixture schemaVersion = %d, want 1", fixture.SchemaVersion)
	}
	if fixture.Source.NodeRoutes != "apps/backend/api/node-routes.json" || fixture.Source.RouteSource != "apps/web/server/index.mjs" {
		t.Fatalf("fixture source is not traceable: %#v", fixture.Source)
	}
	return filesHarness{doc: doc, router: router, fixture: fixture}
}

func loadFilesNodeRoutes(t *testing.T) map[string]filesRoute {
	t.Helper()
	data, err := os.ReadFile("../../api/node-routes.json")
	if err != nil {
		t.Fatalf("read Node route inventory: %v", err)
	}
	var payload struct {
		Routes []filesRoute `json:"routes"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatalf("decode Node route inventory: %v", err)
	}
	result := make(map[string]filesRoute, len(payload.Routes))
	for _, route := range payload.Routes {
		result[route.Method+" "+route.Path] = route
	}
	return result
}

func findFilesRoute(t *testing.T, routes []filesRoute, key string) filesRoute {
	t.Helper()
	for _, route := range routes {
		if route.Method+" "+route.Path == key {
			return route
		}
	}
	t.Fatalf("fixture route %s not found", key)
	return filesRoute{}
}

func findFilesScenario(t *testing.T, name string) filesScenario {
	t.Helper()
	fixture := loadFilesContract(t).fixture
	for _, scenario := range fixture.Scenarios {
		if scenario.Name == name {
			return scenario
		}
	}
	t.Fatalf("fixture scenario %q not found", name)
	return filesScenario{}
}

func routeFilesRequest(router routers.Router, fixture filesRequest) (*openapi3filter.RequestValidationInput, error) {
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

func validateFilesResponse(input *openapi3filter.RequestValidationInput, fixture filesResponse) error {
	header := make(http.Header)
	for key, value := range fixture.Headers {
		header.Set(key, value)
	}
	if header.Get("Content-Type") == "" {
		if fixture.BodyBase64 != "" {
			header.Set("Content-Type", "application/octet-stream")
		} else {
			header.Set("Content-Type", "application/json")
		}
	}
	validationInput := &openapi3filter.ResponseValidationInput{
		RequestValidationInput: input,
		Status:                 fixture.Status,
		Header:                 header,
		Options:                input.Options,
	}
	if fixture.BodyBase64 != "" {
		body, err := base64.StdEncoding.DecodeString(fixture.BodyBase64)
		if err != nil {
			return err
		}
		validationInput.SetBodyBytes(body)
	} else {
		validationInput.SetBodyBytes(fixture.Body)
	}
	return openapi3filter.ValidateResponse(context.Background(), validationInput)
}

var (
	filesUUIDPattern      = regexp.MustCompile(`/[0-9a-f-]{36}`)
	filesGeneratedPattern = regexp.MustCompile(`/generated_[0-9]+`)
)

func filesRouteTemplate(method, path string) string {
	if queryIndex := strings.IndexByte(path, '?'); queryIndex >= 0 {
		path = path[:queryIndex]
	}
	path = filesUUIDPattern.ReplaceAllString(path, "/{id}")
	path = filesGeneratedPattern.ReplaceAllString(path, "/{id}")
	path = strings.Replace(path, "/{id}/parts/1", "/{uploadId}/parts/{partNumber}", 1)
	path = strings.Replace(path, "/{id}/complete", "/{uploadId}/complete", 1)
	path = strings.Replace(path, "/{id}/content", "/{uploadId}/content", 1)
	path = strings.Replace(path, "/{id}/fail", "/{uploadId}/fail", 1)
	path = strings.Replace(path, "/api/workspace/files/{id}/downloads/reserve", "/api/workspace/files/{attachmentId}/downloads/reserve", 1)
	path = strings.Replace(path, "/api/workspace/files/{id}/preview", "/api/workspace/files/{attachmentId}/preview", 1)
	path = strings.Replace(path, "/api/workspace/files/{id}/download", "/api/workspace/files/{attachmentId}/download", 1)
	path = strings.Replace(path, "/api/workspace/files/{id}", "/api/workspace/files/{attachmentId}", 1)
	if strings.HasPrefix(path, "/api/workspace/files/uploads/{id}") {
		path = strings.Replace(path, "/api/workspace/files/uploads/{id}", "/api/workspace/files/uploads/{uploadId}", 1)
	}
	return method + " " + path
}
