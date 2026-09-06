package p2pcontract

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers"
	"github.com/getkin/kin-openapi/routers/legacy"
	"github.com/timestarry/duallane/apps/backend/internal/p2p"
	platformconfig "github.com/timestarry/duallane/apps/backend/internal/platform/config"
)

const p2pContractPath = "../../api/p2p.yaml"

type p2pContractHarness struct {
	doc     *openapi3.T
	router  routers.Router
	handler http.Handler
}

func newP2PContractHarness(t *testing.T) p2pContractHarness {
	t.Helper()

	ctx := context.Background()
	loader := openapi3.NewLoader()
	loader.IsExternalRefsAllowed = false
	doc, err := loader.LoadFromFile(p2pContractPath)
	if err != nil {
		t.Fatalf("load local P2P OpenAPI contract: %v", err)
	}
	if doc.OpenAPI != "3.1.2" {
		t.Fatalf("OpenAPI version = %q, want 3.1.2", doc.OpenAPI)
	}
	if err := doc.Validate(ctx); err != nil {
		t.Fatalf("validate local P2P OpenAPI contract: %v", err)
	}
	router, err := legacy.NewRouter(doc)
	if err != nil {
		t.Fatalf("build OpenAPI request router: %v", err)
	}

	manager := p2p.NewManager(p2p.ManagerOptions{EmptyRoomGrace: time.Hour})
	handler := p2p.NewHandler(p2p.HandlerOptions{
		Config: platformconfig.P2PConfig{
			AppVersion:     "contract-test",
			PublicBaseURL:  "https://duallane.example",
			STUNURLs:       []string{"stun:stun.example"},
			TURNURLs:       []string{"turns:turn.example:5349"},
			TURNUsername:   "turn-user",
			TURNCredential: "turn-credential",
			MaxFrameBytes:  64 * 1024,
			RoomTTL:        2 * time.Hour,
			EmptyRoomGrace: time.Hour,
		},
		Manager: manager,
	})
	t.Cleanup(handler.Close)

	return p2pContractHarness{doc: doc, router: router, handler: handler.Routes()}
}

func TestP2PContractPreservesVersionAndDirectConstKeywords(t *testing.T) {
	harness := newP2PContractHarness(t)
	assertSchemaConst(t, harness.doc, "CreateRoomRequest", "maxPeers", "2")
	assertSchemaConst(t, harness.doc, "CreatedRoom", "maxPeers", "2")
	assertSchemaConst(t, harness.doc, "RoomStatus", "maxPeers", "2")
	assertSchemaConst(t, harness.doc, "HealthResponse", "ok", "true")
	assertSchemaConst(t, harness.doc, "HealthResponse", "service", `"duallane"`)
	assertSchemaConst(t, harness.doc, "HealthResponse", "lane", `"ready"`)
}

func assertSchemaConst(t *testing.T, doc *openapi3.T, schemaName, propertyName, wantJSON string) {
	t.Helper()

	schema := doc.Components.Schemas[schemaName]
	if schema == nil || schema.Value == nil {
		t.Fatalf("schema %q is missing", schemaName)
	}
	property := schema.Value.Properties[propertyName]
	if property == nil || property.Value == nil {
		t.Fatalf("schema %q property %q is missing", schemaName, propertyName)
	}
	got, err := json.Marshal(property.Value.Const)
	if err != nil {
		t.Fatalf("marshal %s.%s const: %v", schemaName, propertyName, err)
	}
	if string(got) != wantJSON {
		t.Fatalf("schema %s.%s const = %s, want %s", schemaName, propertyName, got, wantJSON)
	}
}

func TestGeneratedModelDoesNotReplaceConstValidation(t *testing.T) {
	var body CreateRoomRequest
	if err := json.Unmarshal([]byte(`{"maxPeers":3}`), &body); err != nil {
		t.Fatalf("generated request model rejected JSON before schema validation: %v", err)
	}
	if body.MaxPeers != CreateRoomRequestMaxPeers(3) {
		t.Fatalf("generated request model maxPeers = %d, want 3", body.MaxPeers)
	}
	if body.MaxPeers.Valid() {
		t.Fatal("generated enum helper incorrectly accepted maxPeers=3")
	}

	harness := newP2PContractHarness(t)
	request := newP2PRequest(http.MethodPost, "/api/p2p/rooms", `{"maxPeers":3}`)
	if _, err := validateP2PRequest(harness.router, request); err == nil {
		t.Fatal("OpenAPI request validation accepted maxPeers=3")
	}
}

func TestP2PHTTPConformsToOpenAPIAndRejectsInvalidBody(t *testing.T) {
	harness := newP2PContractHarness(t)

	validRequest := newP2PRequest(http.MethodPost, "/api/p2p/rooms", `{"maxPeers":2}`)
	validInput, err := validateP2PRequest(harness.router, validRequest)
	if err != nil {
		t.Fatalf("valid create-room request failed OpenAPI validation: %v", err)
	}

	validResponse := serveP2PRequest(harness.handler, validRequest)
	if validResponse.Code != http.StatusCreated {
		t.Fatalf("valid create-room status = %d, body = %s", validResponse.Code, validResponse.Body.String())
	}
	if err := validateP2PResponse(validInput, validResponse); err != nil {
		t.Fatalf("valid create-room response failed OpenAPI validation: %v", err)
	}

	invalidRequest := newP2PRequest(http.MethodPost, "/api/p2p/rooms", `{"maxPeers":3}`)
	if _, err := validateP2PRequest(harness.router, invalidRequest); err == nil {
		t.Fatal("OpenAPI request validation accepted invalid maxPeers=3")
	}
	invalidInput, err := routeP2PRequest(harness.router, invalidRequest)
	if err != nil {
		t.Fatalf("route invalid create-room request: %v", err)
	}
	invalidResponse := serveP2PRequest(harness.handler, invalidRequest)
	if invalidResponse.Code != http.StatusBadRequest {
		t.Fatalf("invalid create-room status = %d, body = %s", invalidResponse.Code, invalidResponse.Body.String())
	}
	if err := validateP2PResponse(invalidInput, invalidResponse); err != nil {
		t.Fatalf("invalid create-room error response failed OpenAPI validation: %v", err)
	}
}

func TestP2PHTTPResponseValidationRejectsEveryDirectConstViolation(t *testing.T) {
	harness := newP2PContractHarness(t)

	healthRequest := newP2PRequest(http.MethodGet, "/api/health", "")
	healthInput, err := validateP2PRequest(harness.router, healthRequest)
	if err != nil {
		t.Fatalf("health request failed OpenAPI validation: %v", err)
	}
	healthResponse := serveP2PRequest(harness.handler, healthRequest)
	if err := validateP2PResponse(healthInput, healthResponse); err != nil {
		t.Fatalf("health response failed OpenAPI validation: %v", err)
	}

	for _, test := range []struct {
		field string
		value any
	}{
		{field: "ok", value: false},
		{field: "service", value: "not-duallane"},
		{field: "lane", value: "not-ready"},
	} {
		t.Run("health."+test.field, func(t *testing.T) {
			invalidHealth := responseWithJSONField(t, healthResponse, test.field, test.value)
			if err := validateP2PResponse(healthInput, invalidHealth); err == nil {
				t.Fatalf("OpenAPI response validation accepted health %s=%v", test.field, test.value)
			}
		})
	}

	createRequest := newP2PRequest(http.MethodPost, "/api/p2p/rooms", `{"maxPeers":2}`)
	createInput, err := validateP2PRequest(harness.router, createRequest)
	if err != nil {
		t.Fatalf("create-room request failed OpenAPI validation: %v", err)
	}
	createResponse := serveP2PRequest(harness.handler, createRequest)
	if err := validateP2PResponse(createInput, createResponse); err != nil {
		t.Fatalf("created-room response failed OpenAPI validation: %v", err)
	}
	if err := validateP2PResponse(createInput, responseWithJSONField(t, createResponse, "maxPeers", 3)); err == nil {
		t.Fatal("OpenAPI response validation accepted CreatedRoom maxPeers=3")
	}

	var created map[string]any
	if err := json.Unmarshal(createResponse.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode created-room response fixture: %v", err)
	}
	roomID, ok := created["roomId"].(string)
	if !ok || roomID == "" {
		t.Fatalf("created-room response roomId = %#v", created["roomId"])
	}
	statusRequest := newP2PRequest(http.MethodGet, "/api/p2p/rooms/"+roomID, "")
	statusInput, err := validateP2PRequest(harness.router, statusRequest)
	if err != nil {
		t.Fatalf("room-status request failed OpenAPI validation: %v", err)
	}
	statusResponse := serveP2PRequest(harness.handler, statusRequest)
	if err := validateP2PResponse(statusInput, statusResponse); err != nil {
		t.Fatalf("room-status response failed OpenAPI validation: %v", err)
	}
	if err := validateP2PResponse(statusInput, responseWithJSONField(t, statusResponse, "maxPeers", 3)); err == nil {
		t.Fatal("OpenAPI response validation accepted RoomStatus maxPeers=3")
	}
}

func TestP2PContractCoversUnknownOmittedAndNullEdgeSemantics(t *testing.T) {
	harness := newP2PContractHarness(t)

	unknownFieldRequest := newP2PRequest(http.MethodPost, "/api/p2p/rooms", `{"maxPeers":2,"futureField":true}`)
	unknownFieldInput, err := validateP2PRequest(harness.router, unknownFieldRequest)
	if err != nil {
		t.Fatalf("OpenAPI rejected documented additional property: %v", err)
	}
	unknownFieldResponse := serveP2PRequest(harness.handler, unknownFieldRequest)
	if unknownFieldResponse.Code != http.StatusCreated {
		t.Fatalf("unknown-field request status = %d, body = %s", unknownFieldResponse.Code, unknownFieldResponse.Body.String())
	}
	if err := validateP2PResponse(unknownFieldInput, unknownFieldResponse); err != nil {
		t.Fatalf("unknown-field create response failed OpenAPI validation: %v", err)
	}

	for _, test := range []struct {
		name string
		body string
	}{
		{name: "omitted required maxPeers", body: `{}`},
		{name: "null maxPeers", body: `{"maxPeers":null}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := newP2PRequest(http.MethodPost, "/api/p2p/rooms", test.body)
			if _, err := validateP2PRequest(harness.router, request); err == nil {
				t.Fatal("OpenAPI accepted an invalid omitted/null request body")
			}
			input, err := routeP2PRequest(harness.router, request)
			if err != nil {
				t.Fatalf("route invalid request: %v", err)
			}
			response := serveP2PRequest(harness.handler, request)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("invalid request status = %d, body = %s", response.Code, response.Body.String())
			}
			if err := validateP2PResponse(input, response); err != nil {
				t.Fatalf("invalid request error response failed OpenAPI validation: %v", err)
			}
		})
	}

	iceRequest := newP2PRequest(http.MethodGet, "/api/p2p/ice-servers", "")
	iceInput, err := validateP2PRequest(harness.router, iceRequest)
	if err != nil {
		t.Fatalf("ICE request failed OpenAPI validation: %v", err)
	}
	iceResponse := serveP2PRequest(harness.handler, iceRequest)
	if err := validateP2PResponse(iceInput, iceResponse); err != nil {
		t.Fatalf("ICE response failed OpenAPI oneOf/omission validation: %v", err)
	}
	var icePayload struct {
		ICEServers []map[string]any `json:"iceServers"`
	}
	if err := json.Unmarshal(iceResponse.Body.Bytes(), &icePayload); err != nil {
		t.Fatalf("decode ICE response fixture: %v", err)
	}
	if len(icePayload.ICEServers) != 2 {
		t.Fatalf("ICE server count = %d, want STUN plus TURN", len(icePayload.ICEServers))
	}
	if _, ok := icePayload.ICEServers[0]["username"]; ok {
		t.Fatal("optional STUN username was not omitted")
	}
	if _, ok := icePayload.ICEServers[0]["credential"]; ok {
		t.Fatal("optional STUN credential was not omitted")
	}

	invalidICE := responseWithJSONField(t, iceResponse, "iceServers", []any{
		map[string]any{"urls": "stun:stun.example", "username": nil},
	})
	if err := validateP2PResponse(iceInput, invalidICE); err == nil {
		t.Fatal("OpenAPI response validation accepted nullable ICE username")
	}
}

func newP2PRequest(method, path, body string) *http.Request {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	return request
}

func routeP2PRequest(router routers.Router, request *http.Request) (*openapi3filter.RequestValidationInput, error) {
	route, pathParams, err := router.FindRoute(request)
	if err != nil {
		return nil, err
	}
	return &openapi3filter.RequestValidationInput{
		Request:    request,
		PathParams: pathParams,
		Route:      route,
	}, nil
}

func validateP2PRequest(router routers.Router, request *http.Request) (*openapi3filter.RequestValidationInput, error) {
	input, err := routeP2PRequest(router, request)
	if err != nil {
		return nil, err
	}
	return input, openapi3filter.ValidateRequest(context.Background(), input)
}

func serveP2PRequest(handler http.Handler, request *http.Request) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func validateP2PResponse(input *openapi3filter.RequestValidationInput, response *httptest.ResponseRecorder) error {
	body, err := io.ReadAll(response.Result().Body)
	if err != nil {
		return fmt.Errorf("read response body: %w", err)
	}
	validationInput := &openapi3filter.ResponseValidationInput{
		RequestValidationInput: input,
		Status:                 response.Code,
		Header:                 response.Header().Clone(),
	}
	validationInput.SetBodyBytes(body)
	return openapi3filter.ValidateResponse(context.Background(), validationInput)
}

func responseWithJSONField(t *testing.T, response *httptest.ResponseRecorder, field string, value any) *httptest.ResponseRecorder {
	t.Helper()

	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response fixture for %s: %v", field, err)
	}
	payload[field] = value
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("encode response fixture for %s: %v", field, err)
	}
	return cloneResponseWithBody(response, body)
}

func cloneResponseWithBody(response *httptest.ResponseRecorder, body []byte) *httptest.ResponseRecorder {
	clone := httptest.NewRecorder()
	for key, values := range response.Header() {
		for _, value := range values {
			clone.Header().Add(key, value)
		}
	}
	clone.WriteHeader(response.Code)
	_, _ = clone.Write(body)
	return clone
}
