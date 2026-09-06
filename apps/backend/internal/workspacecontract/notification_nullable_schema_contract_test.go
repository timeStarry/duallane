package workspacecontract

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/getkin/kin-openapi/openapi3filter"
)

const notificationNullableSchemaFixturePath = "testdata/node-notifications-null-schema.json"

type notificationNullableSchemaFixture struct {
	SchemaVersion int                              `json:"schemaVersion"`
	Source        notificationNullableSchemaSource `json:"source"`
	Route         notificationNullableSchemaRoute  `json:"route"`
	Scenarios     []notificationNullableScenario   `json:"scenarios"`
}

type notificationNullableSchemaSource struct {
	NodeFixture        string `json:"nodeFixture"`
	NodeImplementation string `json:"nodeImplementation"`
}

type notificationNullableSchemaRoute struct {
	Method string `json:"method"`
	Path   string `json:"path"`
}

type notificationNullableScenario struct {
	Name         string          `json:"name"`
	NodeScenario string          `json:"nodeScenario"`
	Body         json.RawMessage `json:"body"`
}

func TestWorkspaceNotificationsNullablePatchBodiesValidateAgainstOpenAPI(t *testing.T) {
	harness := loadNotificationsContract(t)
	fixture := loadNotificationNullableSchemaFixture(t)
	if fixture.SchemaVersion != 1 {
		t.Fatalf("schema fixture version = %d, want 1", fixture.SchemaVersion)
	}
	if fixture.Source.NodeFixture != "scripts/backend/testdata/workspace-notifications-null.json" || fixture.Source.NodeImplementation != "apps/web/server/services/workspace-email.mjs" {
		t.Fatalf("schema fixture source is not traceable: %#v", fixture.Source)
	}
	if fixture.Route.Method != "PATCH" || fixture.Route.Path != "/api/workspace/me/notifications" {
		t.Fatalf("schema fixture route = %#v", fixture.Route)
	}

	actualNodeScenarios := loadActualNodeNotificationNullScenarios(t, fixture.Source.NodeFixture)
	for _, scenario := range fixture.Scenarios {
		scenario := scenario
		t.Run(scenario.Name, func(t *testing.T) {
			request := notificationsRequest{
				Method:  fixture.Route.Method,
				Path:    fixture.Route.Path,
				Headers: map[string]string{"content-type": "application/json", "x-workspace-user-id": "usr_owner"},
				Body:    scenario.Body,
			}
			input, err := routeNotificationsRequest(harness.router, request)
			if err != nil {
				t.Fatalf("route nullable request: %v", err)
			}
			if err := openapiRequestValidation(input); err != nil {
				t.Fatalf("nullable request does not conform: %v", err)
			}
			if scenario.NodeScenario == "" {
				return
			}
			actual, ok := actualNodeScenarios[scenario.NodeScenario]
			if !ok {
				t.Fatalf("actual Node fixture is missing scenario %q", scenario.NodeScenario)
			}
			var expectedPayload, actualPayload any
			if err := json.Unmarshal(scenario.Body, &expectedPayload); err != nil {
				t.Fatalf("decode schema fixture body: %v", err)
			}
			if err := json.Unmarshal(actual, &actualPayload); err != nil {
				t.Fatalf("decode actual Node payload: %v", err)
			}
			if !reflect.DeepEqual(expectedPayload, actualPayload) {
				t.Fatalf("payload = %#v, want actual Node payload %#v", expectedPayload, actualPayload)
			}
		})
	}

	ntfyInput, err := routeNotificationsRequest(harness.router, notificationsRequest{
		Method:  "PATCH",
		Path:    "/api/workspace/me/ntfy",
		Headers: map[string]string{"content-type": "application/json", "x-workspace-user-id": "usr_owner"},
		Body:    json.RawMessage(`{"enabled":null}`),
	})
	if err != nil {
		t.Fatalf("route ntfy nullable request: %v", err)
	}
	if err := openapiRequestValidation(ntfyInput); err == nil {
		t.Fatal("ntfy nullable request unexpectedly conforms")
	}
}

func loadNotificationNullableSchemaFixture(t *testing.T) notificationNullableSchemaFixture {
	t.Helper()
	data, err := os.ReadFile(notificationNullableSchemaFixturePath)
	if err != nil {
		t.Fatalf("read notification nullable schema fixture: %v", err)
	}
	var fixture notificationNullableSchemaFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("decode notification nullable schema fixture: %v", err)
	}
	if len(fixture.Scenarios) != 3 {
		t.Fatalf("nullable schema scenario count = %d, want 3", len(fixture.Scenarios))
	}
	return fixture
}

func loadActualNodeNotificationNullScenarios(t *testing.T, relativePath string) map[string]json.RawMessage {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", filepath.FromSlash(relativePath)))
	if err != nil {
		t.Fatalf("read actual Node notification null fixture: %v", err)
	}
	var fixture struct {
		Scenarios []struct {
			Name    string `json:"name"`
			Request struct {
				Payload json.RawMessage `json:"payload"`
			} `json:"request"`
		} `json:"scenarios"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("decode actual Node notification null fixture: %v", err)
	}
	result := make(map[string]json.RawMessage, len(fixture.Scenarios))
	for _, scenario := range fixture.Scenarios {
		result[scenario.Name] = scenario.Request.Payload
	}
	return result
}

func openapiRequestValidation(input *openapi3filter.RequestValidationInput) error {
	return openapi3filter.ValidateRequest(context.Background(), input)
}
