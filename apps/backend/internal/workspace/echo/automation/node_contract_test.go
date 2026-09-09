package automation

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/interactions"
)

// nodeRuntimeFixture is intentionally decoded as JSON values for the
// behavior snapshots. That keeps this test coupled to the published Node
// contract rather than duplicating a second set of Go-only expected maps.
type nodeRuntimeFixture struct {
	CommandInventory     []string        `json:"commandInventory"`
	HelpCommands         []string        `json:"helpCommands"`
	HelpResult           map[string]any  `json:"helpResult"`
	UnknownResourceNames []string        `json:"unknownResourceNames"`
	Authorization        map[string]bool `json:"authorization"`
	Workflow             struct {
		Initialization map[string]json.RawMessage `json:"initialization"`
		Steps          map[string]json.RawMessage `json:"steps"`
	} `json:"workflow"`
}

func TestNodeRuntimeContractSnapshots(t *testing.T) {
	fixture := loadNodeRuntimeFixture(t)
	definitions := NewCommandDefinitions(Options{})
	registry, err := NewCommandRegistry(Options{})
	if err != nil {
		t.Fatal(err)
	}

	gotInventory := make([]string, 0, len(definitions))
	definitionsByName := make(map[string]*interactions.CommandDefinition, len(definitions))
	for index := range definitions {
		definition := definitions[index]
		gotInventory = append(gotInventory, definition.Name)
		definitionsByName[definition.Name] = &definition
	}
	assertJSONEqual(t, "command inventory", fixture.CommandInventory, gotInventory)

	helpDefinition := definitionsByName["help"]
	if helpDefinition == nil || helpDefinition.Execute == nil {
		t.Fatal("help command is not executable")
	}
	helpResult, err := helpDefinition.Execute(context.Background(), interactions.CommandExecution{})
	if err != nil {
		t.Fatal(err)
	}
	helpMap, ok := helpResult.Result.(map[string]any)
	if !ok {
		t.Fatalf("help result type = %T", helpResult.Result)
	}
	assertJSONEqual(t, "help result", fixture.HelpResult, helpMap)
	assertJSONEqual(t, "help commands", fixture.HelpCommands, helpMap["commands"])

	for _, name := range fixture.UnknownResourceNames {
		if registry.Get(name) != nil {
			t.Fatalf("Node resource %q unexpectedly registered as command", name)
		}
	}

	owner := &auth.Actor{ID: "usr_owner", Role: "owner", Kind: "human"}
	member := &auth.Actor{ID: "usr_member", Role: "member", Kind: "human"}
	auditor := &auth.Actor{ID: "usr_auditor", Role: "auditor", Kind: "human"}
	release := definitionsByName["release"]
	need := definitionsByName["need"]
	if release == nil || release.Authorize == nil || need == nil || need.Authorize == nil {
		t.Fatal("permission-bearing commands are not executable")
	}
	gotAuthorization := map[string]bool{
		"ownerRelease":  authorizeCommand(t, release, owner),
		"memberRelease": authorizeCommand(t, release, member),
		"auditorNeed":   authorizeCommand(t, need, auditor),
		"memberNeed":    authorizeCommand(t, need, member),
	}
	assertJSONEqual(t, "command authorization", fixture.Authorization, gotAuthorization)

	workflows := NewWorkflowDefinitions(Options{})
	workflowByType := make(map[string]*interactions.WorkflowDefinition, len(workflows))
	for index := range workflows {
		definition := workflows[index]
		workflowByType[definition.Type] = &definition
	}
	requirement := workflowByType[RequirementWorkflowType]
	publish := workflowByType[PublishWorkflowType]
	if requirement == nil || publish == nil {
		t.Fatal("Node workflow definitions are not registered")
	}

	requirementInitial := executeWorkflowInitialize(t, requirement, map[string]any{})
	publishInitial := executeWorkflowInitialize(t, publish, map[string]any{
		"title":       "T",
		"description": "D",
		"question":    "Q",
		"options":     []any{"A"},
	})
	assertRawSnapshot(t, "requirement initialization", fixture.Workflow.Initialization["requirement"], requirementInitial)
	assertRawSnapshot(t, "publish initialization", fixture.Workflow.Initialization["publish"], publishInitial)

	requirementState := resultState(t, requirementInitial)
	publishState := resultState(t, publishInitial)
	requirementPartial := executeWorkflowContinue(t, requirement, requirementState, map[string]any{"title": "Synthetic title"})
	publishPartial := executeWorkflowContinue(t, publish, publishState, map[string]any{})
	assertRawSnapshot(t, "requirement partial step", fixture.Workflow.Steps["requirementPartial"], requirementPartial)
	assertRawSnapshot(t, "publish partial step", fixture.Workflow.Steps["publishPartial"], publishPartial)
}

func loadNodeRuntimeFixture(t *testing.T) nodeRuntimeFixture {
	t.Helper()
	path := filepath.Join("testdata", "node-runtime.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read Node runtime fixture %s: %v", path, err)
	}
	var fixture nodeRuntimeFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("decode Node runtime fixture %s: %v", path, err)
	}
	return fixture
}

func authorizeCommand(t *testing.T, definition *interactions.CommandDefinition, actor *auth.Actor) bool {
	t.Helper()
	allowed, err := definition.Authorize(context.Background(), interactions.CommandAuthorization{Actor: actor})
	if err != nil {
		t.Fatalf("authorize %s: %v", definition.Name, err)
	}
	return allowed
}

func executeWorkflowInitialize(t *testing.T, definition *interactions.WorkflowDefinition, input map[string]any) map[string]any {
	t.Helper()
	result, err := definition.Initialize(context.Background(), interactions.WorkflowExecution{Input: input})
	if err != nil {
		t.Fatalf("initialize %s: %v", definition.Type, err)
	}
	return workflowResultSnapshot(result)
}

func executeWorkflowContinue(t *testing.T, definition *interactions.WorkflowDefinition, state, input any) map[string]any {
	t.Helper()
	result, err := definition.Continue(context.Background(), interactions.WorkflowExecution{
		State:    state,
		Input:    input,
		Workflow: interactions.Workflow{ID: "wf-contract", Revision: 1},
	})
	if err != nil {
		t.Fatalf("continue %s: %v", definition.Type, err)
	}
	return workflowResultSnapshot(result)
}

func workflowResultSnapshot(result interactions.WorkflowResult) map[string]any {
	snapshot := map[string]any{"state": result.State}
	if result.Status != "" {
		snapshot["status"] = result.Status
	}
	if result.Result != nil {
		snapshot["result"] = result.Result
	}
	return snapshot
}

func resultState(t *testing.T, snapshot map[string]any) any {
	t.Helper()
	state, ok := snapshot["state"]
	if !ok {
		t.Fatal("workflow snapshot has no state")
	}
	return state
}

func assertRawSnapshot(t *testing.T, name string, want json.RawMessage, got any) {
	t.Helper()
	if len(want) == 0 {
		t.Fatalf("Node fixture is missing %s snapshot", name)
	}
	var wantValue any
	if err := json.Unmarshal(want, &wantValue); err != nil {
		t.Fatalf("decode Node %s snapshot: %v", name, err)
	}
	assertJSONEqual(t, name, wantValue, got)
}

func assertJSONEqual(t *testing.T, name string, want, got any) {
	t.Helper()
	wantJSON, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("marshal Node %s expectation: %v", name, err)
	}
	gotJSON, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal Go %s observation: %v", name, err)
	}
	var wantValue, gotValue any
	if err := json.Unmarshal(wantJSON, &wantValue); err != nil {
		t.Fatalf("normalize Node %s expectation: %v", name, err)
	}
	if err := json.Unmarshal(gotJSON, &gotValue); err != nil {
		t.Fatalf("normalize Go %s observation: %v", name, err)
	}
	if !reflect.DeepEqual(wantValue, gotValue) {
		t.Fatalf("%s mismatch:\nNode: %s\nGo:   %s", name, wantJSON, gotJSON)
	}
}
