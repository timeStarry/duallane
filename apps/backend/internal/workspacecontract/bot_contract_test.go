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
	"strings"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers"
	"github.com/getkin/kin-openapi/routers/legacy"
)

const (
	workspaceBotsContractPath = "../../api/workspace-bots.yaml"
	botGatewayContractPath    = "../../api/bot-gateway.yaml"
	botContractFixturePath    = "testdata/node-bot-contract.json"
)

type botContractRoute struct {
	Method    string `json:"method"`
	Path      string `json:"path"`
	NodePath  string `json:"nodePath"`
	Source    string `json:"source"`
	Transport string `json:"transport"`
	Lane      string `json:"lane"`
}

type botContractFixture struct {
	SchemaVersion int                   `json:"schemaVersion"`
	Source        botContractSource     `json:"source"`
	Routes        []botContractRoute    `json:"routes"`
	Scenarios     []botContractScenario `json:"scenarios"`
}

type botContractSource struct {
	NodeRoutes         string `json:"nodeRoutes"`
	OwnerRouteSource   string `json:"ownerRouteSource"`
	GatewayRouteSource string `json:"gatewayRouteSource"`
	MessageRuntime     string `json:"messageRuntime"`
}

type botContractScenario struct {
	Name     string             `json:"name"`
	Document string             `json:"document"`
	Request  botFixtureRequest  `json:"request"`
	Response botFixtureResponse `json:"response"`
}

type botFixtureRequest struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    json.RawMessage   `json:"body"`
}

type botFixtureResponse struct {
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body"`
}

type botContractHarness struct {
	docs    map[string]*openapi3.T
	routers map[string]routers.Router
	fixture botContractFixture
}

func TestBotContractsAreVersionedAndTraceable(t *testing.T) {
	harness := loadBotContract(t)
	if harness.fixture.SchemaVersion != 1 {
		t.Fatalf("fixture schemaVersion = %d, want 1", harness.fixture.SchemaVersion)
	}
	if harness.fixture.Source.NodeRoutes != "apps/backend/api/node-routes.json" {
		t.Fatalf("fixture node route source = %q", harness.fixture.Source.NodeRoutes)
	}
	if harness.fixture.Source.OwnerRouteSource != "apps/web/server/routes/workspace-bots.mjs" {
		t.Fatalf("fixture owner route source = %q", harness.fixture.Source.OwnerRouteSource)
	}
	if harness.fixture.Source.GatewayRouteSource != "apps/web/server/routes/workspace-bot-gateway.mjs" {
		t.Fatalf("fixture Gateway route source = %q", harness.fixture.Source.GatewayRouteSource)
	}
	if got, want := len(harness.fixture.Scenarios), 2; got != want {
		t.Fatalf("fixture scenario count = %d, want %d", got, want)
	}

	nodeRoutes := loadNodeRoutes(t)
	fixtureRoutes := make(map[string]botContractRoute, len(harness.fixture.Routes))
	for _, route := range harness.fixture.Routes {
		key := route.Method + " " + route.Path
		if _, exists := fixtureRoutes[key]; exists {
			t.Fatalf("duplicate fixture route %s", key)
		}
		fixtureRoutes[key] = route
		docName := botContractDocument(route.Path)
		pathItem := harness.docs[docName].Paths.Find(route.Path)
		if pathItem == nil || pathItem.Operations()[route.Method] == nil {
			t.Fatalf("OpenAPI is missing %s %s", route.Method, route.Path)
		}
		if route.Transport != "websocket" {
			nodeRoute, inInventory := nodeRoutes[key]
			if inInventory && (nodeRoute.NodePath != route.NodePath || nodeRoute.Source != route.Source) {
				t.Fatalf("fixture route %s = %#v, Node inventory = %#v", key, route, nodeRoute)
			}
		}
	}
	for key, route := range nodeRoutes {
		if !isBotRoute(route.Path) {
			continue
		}
		if _, ok := fixtureRoutes[key]; !ok {
			t.Fatalf("fixture omitted Node Bot route %s", key)
		}
	}
	if len(fixtureRoutes) != len(nodeBotRoutes(nodeRoutes))+4 {
		t.Fatalf("fixture route count = %d, want Node Bot routes %d plus setup and websocket routes", len(fixtureRoutes), len(nodeBotRoutes(nodeRoutes)))
	}

	if harness.docs["workspace-bots"].Components.SecuritySchemes["workspaceSession"] == nil {
		t.Fatal("workspace-bots OpenAPI is missing workspaceSession")
	}
	if harness.docs["bot-gateway"].Components.SecuritySchemes["botBearer"] == nil {
		t.Fatal("bot-gateway OpenAPI is missing botBearer")
	}
}

func TestBotContractsUseTheCorrectTrustLane(t *testing.T) {
	harness := loadBotContract(t)
	for _, route := range harness.fixture.Routes {
		doc := harness.docs[botContractDocument(route.Path)]
		operation := doc.Paths.Find(route.Path).Operations()[route.Method]
		key := route.Method + " " + route.Path
		publicSetup := route.Path == "/api/bot-gateway/v1/setup/request" ||
			route.Path == "/api/bot-gateway/v1/setup/status" ||
			route.Path == "/api/bot-gateway/v1/setup/exchange"
		if publicSetup {
			if operation.Security != nil {
				t.Fatalf("public setup route %s unexpectedly requires security: %#v", key, operation.Security)
			}
			continue
		}
		want := "workspaceSession"
		if strings.HasPrefix(route.Path, "/api/bot-gateway/") || route.Path == "/ws/bot-gateway" {
			want = "botBearer"
		}
		if operation.Security == nil || len(*operation.Security) != 1 || len((*operation.Security)[0]) != 1 {
			t.Fatalf("route %s has unexpected security requirement %#v", key, operation.Security)
		}
		if _, ok := (*operation.Security)[0][want]; !ok {
			t.Fatalf("route %s requires %s, got %#v", key, want, operation.Security)
		}
	}
}

func TestNodeBotFixturesValidateAgainstOpenAPI(t *testing.T) {
	harness := loadBotContract(t)
	for _, scenario := range harness.fixture.Scenarios {
		t.Run(scenario.Name, func(t *testing.T) {
			router := harness.routers[scenario.Document]
			input, err := routeBotRequest(router, scenario.Request)
			if err != nil {
				t.Fatalf("route fixture request: %v", err)
			}
			if err := openapi3filter.ValidateRequest(context.Background(), input); err != nil {
				t.Fatalf("Node request does not conform: %v", err)
			}
			if err := validateBotResponse(input, scenario.Response); err != nil {
				t.Fatalf("Node response does not conform: %v", err)
			}
		})
	}
}

func TestBotGatewayMessageContractRejectsAnExtraAuthorField(t *testing.T) {
	harness := loadBotContract(t)
	scenario := harness.fixture.Scenarios[1]
	input, err := routeBotRequest(harness.routers["bot-gateway"], scenario.Request)
	if err != nil {
		t.Fatal(err)
	}
	var envelope map[string]any
	if err := json.Unmarshal(scenario.Response.Body, &envelope); err != nil {
		t.Fatal(err)
	}
	message, ok := envelope["message"].(map[string]any)
	if !ok {
		t.Fatalf("message envelope = %#v", envelope["message"])
	}
	if _, present := message["author"]; present {
		t.Fatal("Node Gateway message golden unexpectedly contains author")
	}
	message["author"] = map[string]any{"id": "forged"}
	mutated, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateBotResponseBody(input, scenario.Response.Status, mutated); err == nil {
		t.Fatal("Gateway message schema accepted an extra author field")
	}
}

func loadBotContract(t *testing.T) botContractHarness {
	t.Helper()
	loader := openapi3.NewLoader()
	loader.IsExternalRefsAllowed = false
	docs := make(map[string]*openapi3.T, 2)
	for name, path := range map[string]string{
		"workspace-bots": workspaceBotsContractPath,
		"bot-gateway":    botGatewayContractPath,
	} {
		doc, err := loader.LoadFromFile(path)
		if err != nil {
			t.Fatalf("load %s OpenAPI: %v", name, err)
		}
		if doc.OpenAPI != "3.1.2" {
			t.Fatalf("%s OpenAPI version = %q, want 3.1.2", name, doc.OpenAPI)
		}
		if err := doc.Validate(context.Background()); err != nil {
			t.Fatalf("validate %s OpenAPI: %v", name, err)
		}
		docs[name] = doc
	}
	fixtureBytes, err := os.ReadFile(botContractFixturePath)
	if err != nil {
		t.Fatalf("read Node Bot fixture: %v", err)
	}
	var fixture botContractFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatalf("decode Node Bot fixture: %v", err)
	}
	routersByDocument := make(map[string]routers.Router, len(docs))
	for name, doc := range docs {
		router, err := legacy.NewRouter(doc)
		if err != nil {
			t.Fatalf("build %s OpenAPI router: %v", name, err)
		}
		routersByDocument[name] = router
	}
	return botContractHarness{docs: docs, routers: routersByDocument, fixture: fixture}
}

func routeBotRequest(router routers.Router, fixture botFixtureRequest) (*openapi3filter.RequestValidationInput, error) {
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

func validateBotResponse(input *openapi3filter.RequestValidationInput, response botFixtureResponse) error {
	return validateBotResponseBody(input, response.Status, response.Body)
}

func validateBotResponseBody(input *openapi3filter.RequestValidationInput, status int, body []byte) error {
	validationInput := &openapi3filter.ResponseValidationInput{
		RequestValidationInput: input,
		Status:                 status,
		Header:                 http.Header{"Content-Type": []string{"application/json"}},
		Options:                input.Options,
	}
	validationInput.SetBodyBytes(body)
	return openapi3filter.ValidateResponse(context.Background(), validationInput)
}

func botContractDocument(path string) string {
	if strings.HasPrefix(path, "/api/workspace/") {
		return "workspace-bots"
	}
	return "bot-gateway"
}

func isBotRoute(path string) bool {
	return strings.HasPrefix(path, "/api/workspace/bots") || strings.HasPrefix(path, "/api/bot-gateway/v1/")
}

func nodeBotRoutes(routes map[string]coreRoute) map[string]coreRoute {
	result := make(map[string]coreRoute)
	for key, route := range routes {
		if isBotRoute(route.Path) {
			result[key] = route
		}
	}
	return result
}

func (r botContractRoute) String() string {
	return fmt.Sprintf("%s %s", r.Method, r.Path)
}
