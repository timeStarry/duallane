package runtime

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/delivery"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/interactions"
)

type hookDelivery struct {
	t         *testing.T
	committed *bool
	kinds     []string
	inputs    []delivery.SyncInput
}

func (h *hookDelivery) record(kind string, input delivery.SyncInput) (delivery.DeliverySummary, error) {
	if !*h.committed {
		h.t.Fatal("delivery ran before the domain returned its durable success")
	}
	h.kinds = append(h.kinds, kind)
	h.inputs = append(h.inputs, input)
	return delivery.DeliverySummary{}, errors.New("synthetic post-commit delivery failure")
}
func (h *hookDelivery) SyncRequirement(_ context.Context, input delivery.SyncInput) (delivery.DeliverySummary, error) {
	return h.record("requirement", input)
}
func (h *hookDelivery) SyncSolicitation(_ context.Context, input delivery.SyncInput) (delivery.DeliverySummary, error) {
	return h.record("solicitation", input)
}
func (h *hookDelivery) SyncRelease(_ context.Context, input delivery.SyncInput) (delivery.DeliverySummary, error) {
	return h.record("release", input)
}

type interactionHookStub struct {
	InteractionService
	committed *bool
	command   interactions.CommandOutcome
	workflow  interactions.WorkflowOutcome
	err       error
}

func (s interactionHookStub) ExecuteCommand(context.Context, interactions.ExecuteCommandInput) (interactions.CommandOutcome, error) {
	*s.committed = s.err == nil
	return s.command, s.err
}
func (s interactionHookStub) ContinueWorkflow(context.Context, string, interactions.ContinueWorkflowInput) (interactions.WorkflowOutcome, error) {
	*s.committed = s.err == nil
	return s.workflow, s.err
}

func TestInteractionHooksRunOnlyAfterSuccessfulMutations(t *testing.T) {
	for _, row := range []struct{ resultType, kind string }{{"release-published", "release"}, {"requirement-transition", "requirement"}, {"requirement-submitted", "requirement"}, {"solicitation-published", "solicitation"}} {
		t.Run(row.resultType, func(t *testing.T) {
			committed := false
			deliver := &hookDelivery{t: t, committed: &committed}
			result := map[string]any{"type": row.resultType, "publicId": "fixture", "version": "1.2.3"}
			stub := interactionHookStub{committed: &committed, command: interactions.CommandOutcome{OK: true, Result: result}, workflow: interactions.WorkflowOutcome{Workflow: interactions.Workflow{Status: "completed"}, Result: result}}
			hook := InteractionHooks{InteractionService: stub, Delivery: deliver, SpaceID: "space-fixture"}
			out, err := hook.ExecuteCommand(context.Background(), interactions.ExecuteCommandInput{})
			if err != nil || !out.OK || len(deliver.kinds) != 1 || deliver.kinds[0] != row.kind || deliver.inputs[0].SpaceID != "space-fixture" {
				t.Fatalf("command hook outcome=%+v err=%v calls=%v", out, err, deliver.kinds)
			}
			stub.command.Replayed = true
			hook.InteractionService = stub
			if _, err := hook.ExecuteCommand(context.Background(), interactions.ExecuteCommandInput{}); err != nil || len(deliver.kinds) != 1 {
				t.Fatal("command replay triggered delivery")
			}
			if _, err := hook.ContinueWorkflow(context.Background(), "actor", interactions.ContinueWorkflowInput{}); err != nil || len(deliver.kinds) != 2 {
				t.Fatal("completed workflow was not synchronized")
			}
			stub.err = errors.New("synthetic domain failure")
			hook.InteractionService = stub
			if _, err := hook.ContinueWorkflow(context.Background(), "actor", interactions.ContinueWorkflowInput{}); err == nil || len(deliver.kinds) != 2 {
				t.Fatal("failed workflow triggered delivery")
			}
		})
	}
}

type cardHookStub struct {
	CardService
	committed *bool
	input     cards.ActionInput
	outcome   cards.ActionOutcome
	cardType  string
	err       error
}

func (s *cardHookStub) ResolveCard(context.Context, string, string, cards.Request) (cards.Resolution, error) {
	return cards.Resolution{Block: cards.CardBlock{CardType: s.cardType}}, nil
}

func (s *cardHookStub) ExecuteAction(_ context.Context, input cards.ActionInput) (cards.ActionOutcome, error) {
	s.input = input
	*s.committed = s.err == nil
	return s.outcome, s.err
}

func TestCardHooksDeriveIdempotencyWithoutMutatingInput(t *testing.T) {
	committed := false
	deliver := &hookDelivery{t: t, committed: &committed}
	stub := &cardHookStub{committed: &committed, cardType: "echo.solicitation", outcome: cards.ActionOutcome{OK: true, Result: map[string]any{"publicId": "SOL-2026-0001"}}}
	hook := CardHooks{CardService: stub, Delivery: deliver, SpaceID: "space-fixture"}
	input := map[string]any{"idempotencyKey": "untrusted-key", "optionIds": []any{"a"}}
	out, err := hook.ExecuteAction(context.Background(), cards.ActionInput{ActionID: "vote", ClientActionID: "client-action", Input: input})
	if err != nil || !out.OK || stub.input.Input.(map[string]any)["idempotencyKey"] != "client-action" || input["idempotencyKey"] != "untrusted-key" {
		t.Fatalf("action hook=%+v err=%v", out, err)
	}
	if len(deliver.kinds) != 1 || deliver.kinds[0] != "solicitation" {
		t.Fatalf("delivery=%v", deliver.kinds)
	}
	stub.outcome.Replayed = true
	if _, err := hook.ExecuteAction(context.Background(), cards.ActionInput{ClientActionID: "client-action"}); err != nil || len(deliver.kinds) != 1 {
		t.Fatal("card replay triggered delivery")
	}
	if _, err := hook.ExecuteAction(context.Background(), cards.ActionInput{ClientActionID: ""}); err == nil {
		t.Fatal("invalid action identity accepted")
	}
}

func TestCardHooksPreserveNonEchoInputContract(t *testing.T) {
	for _, cardType := range []string{"feishu.card", "workspace.topic"} {
		committed := false
		deliver := &hookDelivery{t: t, committed: &committed}
		stub := &cardHookStub{committed: &committed, cardType: cardType, outcome: cards.ActionOutcome{OK: true, Result: map[string]any{"publicId": "not-an-echo-resource"}}}
		hook := CardHooks{CardService: stub, Delivery: deliver}
		for _, input := range []any{nil, map[string]any{}, map[string]any{"idempotencyKey": "client-supplied"}} {
			if _, err := hook.ExecuteAction(context.Background(), cards.ActionInput{ClientActionID: "client-action", Input: input}); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(stub.input.Input, input) || len(deliver.kinds) != 0 {
				t.Fatalf("non-Echo input or delivery changed for %s", cardType)
			}
		}
	}
}
