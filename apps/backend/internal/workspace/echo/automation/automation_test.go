package automation

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/releases"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/solicitations"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/interactions"
)

func TestCommandRegistryMatchesNodeInventoryAndRejectsResourceNames(t *testing.T) {
	registry, err := NewCommandRegistry(Options{})
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range CommandNames {
		definition := registry.Get(name)
		if definition == nil {
			t.Fatalf("command %q is missing", name)
		}
		if definition.Version != CommandVersion || len(definition.Contexts) != 2 || definition.Execute == nil {
			t.Fatalf("command %q is incomplete: %#v", name, definition)
		}
	}
	for _, name := range []string{"idea", "requirements", "solicitations"} {
		if definition := registry.Get(name); definition != nil {
			t.Fatalf("unregistered Node resource name %q became a command", name)
		}
	}

	recognized, err := registry.Recognize("/feedback", interactions.RecognitionContext{ConversationType: "direct", BotUserID: EchoBotUserID})
	if err != nil {
		t.Fatal(err)
	}
	if recognized == nil || recognized.Name != "feedback" || recognized.Arguments.(map[string]any)["type"] != "problem" {
		t.Fatalf("feedback recognition = %#v", recognized)
	}
	recognized, err = registry.Recognize("/release V1.2.3", interactions.RecognitionContext{ConversationType: "direct", BotUserID: EchoBotUserID})
	if err != nil {
		t.Fatal(err)
	}
	if recognized == nil || recognized.Arguments.(ReleaseArguments).Version != "1.2.3" {
		t.Fatalf("release recognition = %#v", recognized)
	}
	unknown, err := registry.Recognize("/idea", interactions.RecognitionContext{ConversationType: "direct", BotUserID: EchoBotUserID})
	if err != nil {
		t.Fatal(err)
	}
	if unknown == nil || unknown.Type != "unknown_command" {
		t.Fatalf("idea recognition = %#v", unknown)
	}
}

func TestNodeParserGoldens(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want any
	}{
		{name: "release-prefix", raw: "v0.15.1", want: ReleaseArguments{Version: "0.15.1"}},
		{name: "requirement-id-uppercase", raw: "req-2026-0007", want: RequirementIDArguments{PublicID: "REQ-2026-0007"}},
		{name: "list-filter", raw: "rejected", want: ListArguments{Phase: "archived", Status: "archived", ArchiveOutcome: "rejected"}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			var got any
			var err error
			switch test.name {
			case "release-prefix":
				got, err = parseReleaseArguments(test.raw)
			case "requirement-id-uppercase":
				got, err = parseRequirementIDArguments(test.raw)
			case "list-filter":
				got, err = parseListArguments(test.raw)
			}
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("got %#v, want %#v", got, test.want)
			}
		})
	}
	if _, err := parseReleaseArguments("1.2"); err == nil {
		t.Fatal("malformed release version was accepted")
	}
	if _, err := parseRequirementIDArguments("REQ-2026-7"); err == nil {
		t.Fatal("malformed requirement id was accepted")
	}
	if _, err := parseEmptyArguments("unexpected"); err == nil {
		t.Fatal("unexpected help arguments were accepted")
	}
	need, err := parseRequirementWorkflowArguments("feedback")
	if err != nil {
		t.Fatal(err)
	}
	if got := need.(map[string]any)["type"]; got != "problem" {
		t.Fatalf("/need feedback type = %#v, want problem", got)
	}
}

func TestWorkflowDefinitionsAreNonEmptyAndRespectAuthorization(t *testing.T) {
	definitions := NewWorkflowDefinitions(Options{})
	if len(definitions) != 2 {
		t.Fatalf("workflow count = %d", len(definitions))
	}
	owner := &auth.Actor{ID: "usr_owner", Role: "owner", Kind: "human"}
	auditor := &auth.Actor{ID: "usr_auditor", Role: "auditor", Kind: "human"}
	for _, definition := range definitions {
		if definition.Initialize == nil || definition.Continue == nil || definition.ValidateState == nil || definition.Project == nil {
			t.Fatalf("workflow %s is incomplete", definition.Type)
		}
		ownerAllowed, err := definition.Authorize(context.Background(), interactions.WorkflowAuthorization{Actor: owner, Operation: "start"})
		if err != nil || !ownerAllowed {
			t.Fatalf("owner authorization for %s = %v, %v", definition.Type, ownerAllowed, err)
		}
		auditorAllowed, err := definition.Authorize(context.Background(), interactions.WorkflowAuthorization{Actor: auditor, Operation: "start"})
		if definition.Type == RequirementWorkflowType {
			if err != nil || auditorAllowed {
				t.Fatalf("auditor authorization for requirement = %v, %v", auditorAllowed, err)
			}
		} else if err != nil || auditorAllowed {
			t.Fatalf("auditor authorization for publish = %v, %v", auditorAllowed, err)
		}
	}
}

func TestRequirementWorkflowUsesCallerTransactionAndIdempotency(t *testing.T) {
	requirementTx := &fakeRequirementTx{}
	shared := &fakeSharedTx{requirements: requirementTx}
	port := &fakeRequirements{tx: requirementTx, submitted: &requirements.Requirement{PublicID: "REQ-2026-0001", State: requirements.StateSubmitted, Phase: requirements.PhaseProposal, Status: requirements.StatusPendingReview, Revision: 1}}
	definition := NewWorkflowDefinitions(Options{Requirements: port})[1]
	result, err := definition.Continue(context.Background(), interactions.WorkflowExecution{
		Tx:       shared,
		Actor:    &auth.Actor{ID: "usr_member", Role: "member", Kind: "human"},
		Context:  interactions.ConversationRecord{ID: "conv-1", SpaceID: "spc_default"},
		Workflow: interactions.Workflow{ID: "wf-1", Revision: 4, Type: RequirementWorkflowType, Version: 1},
		State:    map[string]any{"step": "confirm", "fields": map[string]any{"type": "requirement", "title": "Title", "detail": "Detail", "scenario": "Scenario", "expectedResult": "Expected"}},
		Input:    map[string]any{"confirm": true, "idempotencyKey": "client-key"},
		Request:  interactions.Request{Meta: auth.RequestMeta{RequestID: "req-1"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "completed" || port.submittedCalls != 1 {
		t.Fatalf("result=%#v calls=%d", result, port.submittedCalls)
	}
	if port.gotTx != requirementTx || port.input.IdempotencyKey != "client-key" {
		t.Fatalf("transaction/key mismatch: tx=%T key=%q", port.gotTx, port.input.IdempotencyKey)
	}
}

func TestPublishWorkflowUsesOneSavepointAndOneTypedTransaction(t *testing.T) {
	solicitationTx := &fakeSolicitationTx{}
	shared := &fakeSharedTx{solicitations: solicitationTx}
	port := &fakeSolicitations{tx: solicitationTx, draft: &solicitations.Solicitation{PublicID: "SOL-2026-0001", Status: solicitations.StatusDraft, Revision: 1}, published: &solicitations.Solicitation{PublicID: "SOL-2026-0001", Status: solicitations.StatusOpen, Revision: 2}}
	definition := NewWorkflowDefinitions(Options{Solicitations: port})[0]
	result, err := definition.Continue(context.Background(), interactions.WorkflowExecution{
		Tx:       shared,
		Actor:    &auth.Actor{ID: "usr_owner", Role: "owner", Kind: "human"},
		Context:  interactions.ConversationRecord{ID: "conv-1", SpaceID: "spc_default"},
		Workflow: interactions.Workflow{ID: "wf-publish", Revision: 2, Type: PublishWorkflowType, Version: 1},
		State:    map[string]any{"step": "confirm", "fields": map[string]any{"title": "Title", "description": "Description", "question": "Question", "options": []any{"A", "B"}}},
		Input:    map[string]any{"confirm": true, "idempotencyKey": "publish-key"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "completed" || shared.savepointCalls != 1 || port.createCalls != 1 || port.publishCalls != 1 {
		t.Fatalf("result=%#v savepoints=%d creates=%d publishes=%d", result, shared.savepointCalls, port.createCalls, port.publishCalls)
	}
	if port.createTx != solicitationTx || port.publishTx != solicitationTx {
		t.Fatal("create and publish did not share the same typed transaction")
	}
	if port.createInput.IdempotencyKey != "publish-key:create" || port.publishInput.IdempotencyKey != "publish-key:publish" {
		t.Fatalf("idempotency keys = %q, %q", port.createInput.IdempotencyKey, port.publishInput.IdempotencyKey)
	}
}

func TestPublishWorkflowRollsBackBeforePreservingContentFreeRejection(t *testing.T) {
	solicitationTx := &fakeSolicitationTx{}
	shared := &fakeSharedTx{solicitations: solicitationTx}
	marker := &solicitations.TransactionRejection{Err: solicitations.NewError(solicitations.CodePermissionDenied, "denied", 403), TargetID: "SOL-2026-0001", Reason: "permission.denied"}
	port := &fakeSolicitations{tx: solicitationTx, draft: &solicitations.Solicitation{PublicID: "SOL-2026-0001", Status: solicitations.StatusDraft, Revision: 1}, publishErr: marker}
	definition := NewWorkflowDefinitions(Options{Solicitations: port, Now: func() time.Time { return time.Date(2026, 9, 6, 0, 0, 0, 0, time.UTC) }})[0]
	_, err := definition.Continue(context.Background(), interactions.WorkflowExecution{
		Tx:       shared,
		Actor:    &auth.Actor{ID: "usr_owner", GitHubLogin: "owner", Role: "owner", Kind: "human"},
		Context:  interactions.ConversationRecord{ID: "conv-1", SpaceID: "spc_default"},
		Workflow: interactions.Workflow{ID: "wf-publish", Revision: 2, Type: PublishWorkflowType, Version: 1},
		State:    map[string]any{"step": "confirm", "fields": map[string]any{"title": "Title", "description": "Description", "question": "Question", "options": []any{"A", "B"}}},
		Input:    map[string]any{"confirm": true, "idempotencyKey": "publish-key"},
	})
	var interactionErr *interactions.Error
	if !errors.As(err, &interactionErr) || interactionErr.Code != solicitations.CodePermissionDenied {
		t.Fatalf("error = %v (%T)", err, err)
	}
	if !shared.callbackFailed || shared.savepointCalls != 1 || solicitationTx.auditCalls != 1 {
		t.Fatalf("rollback/audit evidence: failed=%v savepoints=%d audits=%d", shared.callbackFailed, shared.savepointCalls, solicitationTx.auditCalls)
	}
}

func TestPublishWorkflowSavepointInfrastructureFailureDoesNotRunDomain(t *testing.T) {
	solicitationTx := &fakeSolicitationTx{}
	shared := &fakeSharedTx{solicitations: solicitationTx, savepointErr: &SavepointFailure{Err: errors.New("rollback failed")}}
	port := &fakeSolicitations{tx: solicitationTx, draft: &solicitations.Solicitation{PublicID: "SOL-2026-0001"}}
	definition := NewWorkflowDefinitions(Options{Solicitations: port})[0]
	_, err := definition.Continue(context.Background(), interactions.WorkflowExecution{
		Tx:       shared,
		Actor:    &auth.Actor{ID: "usr_owner", Role: "owner", Kind: "human"},
		Context:  interactions.ConversationRecord{SpaceID: "spc_default"},
		Workflow: interactions.Workflow{ID: "wf-publish", Revision: 1},
		State:    map[string]any{"fields": map[string]any{"title": "Title", "description": "Description", "question": "Question", "options": []any{"A"}}},
		Input:    map[string]any{"confirm": true},
	})
	var failure *SavepointFailure
	if !errors.As(err, &failure) || port.createCalls != 0 || solicitationTx.auditCalls != 0 {
		t.Fatalf("err=%v createCalls=%d audits=%d", err, port.createCalls, solicitationTx.auditCalls)
	}
}

func TestPublishWorkflowInvalidResultRollsBackSavepoint(t *testing.T) {
	solicitationTx := &fakeSolicitationTx{}
	shared := &fakeSharedTx{solicitations: solicitationTx}
	port := &fakeSolicitations{tx: solicitationTx, draft: &solicitations.Solicitation{PublicID: "SOL-2026-0001", Status: solicitations.StatusDraft, Revision: 1}}
	definition := NewWorkflowDefinitions(Options{Solicitations: port})[0]
	_, err := definition.Continue(context.Background(), interactions.WorkflowExecution{
		Tx:       shared,
		Actor:    &auth.Actor{ID: "usr_owner", Role: "owner", Kind: "human"},
		Context:  interactions.ConversationRecord{SpaceID: "spc_default"},
		Workflow: interactions.Workflow{ID: "wf-publish", Revision: 1, Type: PublishWorkflowType, Version: 1},
		State:    map[string]any{"fields": map[string]any{"title": "Title", "description": "Description", "question": "Question", "options": []any{"A"}}},
		Input:    map[string]any{"confirm": true},
	})
	var interactionErr *interactions.Error
	if !errors.As(err, &interactionErr) || interactionErr.Code != "echo.invalid_result" {
		t.Fatalf("error = %v (%T)", err, err)
	}
	if !shared.callbackFailed || shared.savepointCalls != 1 || port.createCalls != 1 || port.publishCalls != 1 || solicitationTx.auditCalls != 0 {
		t.Fatalf("invalid-result rollback evidence: failed=%v savepoints=%d creates=%d publishes=%d audits=%d", shared.callbackFailed, shared.savepointCalls, port.createCalls, port.publishCalls, solicitationTx.auditCalls)
	}
}

type fakeSharedTx struct {
	interactions.Tx
	requirements   requirements.Tx
	solicitations  solicitations.Tx
	releases       releases.Tx
	savepointCalls int
	callbackFailed bool
	savepointErr   error
}

func (f *fakeSharedTx) RequirementTransaction() requirements.Tx   { return f.requirements }
func (f *fakeSharedTx) SolicitationTransaction() solicitations.Tx { return f.solicitations }
func (f *fakeSharedTx) ReleaseTransaction() releases.Tx           { return f.releases }
func (f *fakeSharedTx) WithEchoSavepoint(ctx context.Context, _ string, callback func(context.Context) error) error {
	f.savepointCalls++
	if f.savepointErr != nil {
		return f.savepointErr
	}
	err := callback(ctx)
	if err != nil {
		f.callbackFailed = true
	}
	return err
}

type fakeRequirementTx struct{ requirements.Tx }

type fakeRequirements struct {
	tx             requirements.Tx
	submitted      *requirements.Requirement
	submittedCalls int
	gotTx          requirements.Tx
	input          requirements.SubmitInput
}

func (f *fakeRequirements) Get(context.Context, requirements.GetInput) (*requirements.Requirement, error) {
	return f.submitted, nil
}
func (f *fakeRequirements) ListPage(context.Context, requirements.ListInput) (requirements.RequirementPage, error) {
	return requirements.RequirementPage{Items: []requirements.Requirement{}}, nil
}
func (f *fakeRequirements) SubmitInTx(_ context.Context, tx requirements.Tx, input requirements.SubmitInput) (*requirements.Requirement, error) {
	f.submittedCalls++
	f.gotTx = tx
	f.input = input
	return f.submitted, nil
}
func (f *fakeRequirements) TransitionInTx(context.Context, requirements.Tx, requirements.TransitionInput) (*requirements.Requirement, error) {
	return f.submitted, nil
}

type fakeSolicitationTx struct {
	solicitations.Tx
	auditCalls int
}

func (f *fakeSolicitationTx) WriteAudit(context.Context, solicitations.AuditInput) error {
	f.auditCalls++
	return nil
}

type fakeSolicitations struct {
	tx           solicitations.Tx
	draft        *solicitations.Solicitation
	published    *solicitations.Solicitation
	publishErr   error
	createCalls  int
	publishCalls int
	createTx     solicitations.Tx
	publishTx    solicitations.Tx
	createInput  solicitations.CreateInput
	publishInput solicitations.TransitionInput
}

func (f *fakeSolicitations) CreateInTx(_ context.Context, tx solicitations.Tx, input solicitations.CreateInput) (*solicitations.Solicitation, error) {
	f.createCalls++
	f.createTx = tx
	f.createInput = input
	return f.draft, nil
}
func (f *fakeSolicitations) PublishInTx(_ context.Context, tx solicitations.Tx, input solicitations.TransitionInput) (*solicitations.Solicitation, error) {
	f.publishCalls++
	f.publishTx = tx
	f.publishInput = input
	if f.publishErr != nil {
		return nil, f.publishErr
	}
	return f.published, nil
}
