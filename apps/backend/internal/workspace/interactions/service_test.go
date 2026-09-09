package interactions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
)

type interactionFakeState struct {
	actors              map[string]*auth.Actor
	conversations       map[string]ConversationRecord
	conversationMembers map[string]bool
	botMembers          map[string]bool
	commands            map[string]CommandRunRecord
	workflows           map[string]WorkflowRecord
	rates               map[string]int
	audits              []AuditInput
	events              []EventInput
	sequence            int64
}

func newInteractionFakeState() *interactionFakeState {
	return &interactionFakeState{
		actors:              make(map[string]*auth.Actor),
		conversations:       make(map[string]ConversationRecord),
		conversationMembers: make(map[string]bool),
		botMembers:          make(map[string]bool),
		commands:            make(map[string]CommandRunRecord),
		workflows:           make(map[string]WorkflowRecord),
		rates:               make(map[string]int),
		sequence:            1,
	}
}

type interactionFakeRepo struct {
	mu    sync.Mutex
	state *interactionFakeState
}

type interactionFakeTx struct {
	state *interactionFakeState
}

func (r *interactionFakeRepo) WithTx(_ context.Context, callback func(Tx) error) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	snapshot := cloneInteractionState(r.state)
	err := callback(&interactionFakeTx{state: r.state})
	if err != nil {
		r.state = snapshot
	}
	return err
}

func cloneInteractionState(source *interactionFakeState) *interactionFakeState {
	target := newInteractionFakeState()
	target.sequence = source.sequence
	for id, actor := range source.actors {
		copy := *actor
		target.actors[id] = &copy
	}
	for id, conversation := range source.conversations {
		target.conversations[id] = conversation
	}
	for key, value := range source.conversationMembers {
		target.conversationMembers[key] = value
	}
	for key, value := range source.botMembers {
		target.botMembers[key] = value
	}
	for key, value := range source.commands {
		target.commands[key] = cloneCommandRun(value)
	}
	for key, value := range source.workflows {
		target.workflows[key] = cloneWorkflow(value)
	}
	for key, value := range source.rates {
		target.rates[key] = value
	}
	target.audits = append([]AuditInput(nil), source.audits...)
	for _, event := range source.events {
		event.PayloadJSON = append([]byte(nil), event.PayloadJSON...)
		target.events = append(target.events, event)
	}
	return target
}

func cloneCommandRun(value CommandRunRecord) CommandRunRecord {
	copy := value
	copy.ConversationID = cloneString(value.ConversationID)
	copy.BotUserID = cloneString(value.BotUserID)
	copy.ResultCardID = cloneString(value.ResultCardID)
	copy.ArgumentsJSON = append([]byte(nil), value.ArgumentsJSON...)
	copy.ResultJSON = append([]byte(nil), value.ResultJSON...)
	copy.CompletedAt = cloneTime(value.CompletedAt)
	return copy
}

func cloneWorkflow(value WorkflowRecord) WorkflowRecord {
	copy := value
	copy.ConversationID = cloneString(value.ConversationID)
	copy.BotUserID = cloneString(value.BotUserID)
	copy.StateJSON = append([]byte(nil), value.StateJSON...)
	copy.ClientInvocationID = cloneString(value.ClientInvocationID)
	copy.StartRequestHash = cloneString(value.StartRequestHash)
	return copy
}

func cloneString(value *string) *string {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func interactionCommandKey(spaceID, actorID, clientID string) string {
	return spaceID + ":" + actorID + ":" + clientID
}

func interactionWorkflowInvocationKey(spaceID, actorID, clientID string) string {
	return spaceID + ":" + actorID + ":" + clientID
}

func interactionMembershipKey(conversationID, userID string) string {
	return conversationID + ":" + userID
}

func readInteractionActor(state *interactionFakeState, spaceID, userID string) (*auth.Actor, error) {
	actor := state.actors[userID]
	if actor == nil {
		return nil, nil
	}
	copy := *actor
	if _, ok := state.conversations[spaceID]; ok {
		return &copy, nil
	}
	return &copy, nil
}

func (r *interactionFakeRepo) LookupActor(_ context.Context, spaceID, userID string) (*auth.Actor, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return readInteractionActor(r.state, spaceID, userID)
}
func (r *interactionFakeRepo) GetConversation(_ context.Context, spaceID, conversationID string) (*ConversationRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	conversation, ok := r.state.conversations[conversationID]
	if !ok || conversation.SpaceID != spaceID {
		return nil, nil
	}
	return &conversation, nil
}
func (r *interactionFakeRepo) ConversationMemberActive(_ context.Context, _ string, conversationID, userID string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.state.conversationMembers[interactionMembershipKey(conversationID, userID)], nil
}
func (r *interactionFakeRepo) BotMemberActive(_ context.Context, _ string, conversationID, userID string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.state.botMembers[interactionMembershipKey(conversationID, userID)], nil
}
func (r *interactionFakeRepo) GetCommandRun(_ context.Context, spaceID, actorID, clientID string) (*CommandRunRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	run, ok := r.state.commands[interactionCommandKey(spaceID, actorID, clientID)]
	if !ok {
		return nil, nil
	}
	copy := cloneCommandRun(run)
	return &copy, nil
}
func (r *interactionFakeRepo) GetWorkflow(_ context.Context, spaceID, workflowID string) (*WorkflowRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	workflow, ok := r.state.workflows[workflowID]
	if !ok || workflow.SpaceID != spaceID {
		return nil, nil
	}
	copy := cloneWorkflow(workflow)
	return &copy, nil
}
func (r *interactionFakeRepo) GetWorkflowByInvocation(_ context.Context, spaceID, actorID, clientID string) (*WorkflowRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	workflow, ok := r.state.workflows[interactionWorkflowInvocationKey(spaceID, actorID, clientID)]
	if !ok {
		return nil, nil
	}
	copy := cloneWorkflow(workflow)
	return &copy, nil
}
func (r *interactionFakeRepo) ListActiveWorkflows(_ context.Context, actorID, conversationID, botUserID string, limit int) ([]WorkflowRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return listInteractionWorkflows(r.state, actorID, conversationID, botUserID, limit), nil
}

func (tx *interactionFakeTx) LookupActor(_ context.Context, spaceID, userID string) (*auth.Actor, error) {
	return readInteractionActor(tx.state, spaceID, userID)
}
func (tx *interactionFakeTx) GetConversation(_ context.Context, spaceID, conversationID string) (*ConversationRecord, error) {
	conversation, ok := tx.state.conversations[conversationID]
	if !ok || conversation.SpaceID != spaceID {
		return nil, nil
	}
	return &conversation, nil
}
func (tx *interactionFakeTx) ConversationMemberActive(_ context.Context, _ string, conversationID, userID string) (bool, error) {
	return tx.state.conversationMembers[interactionMembershipKey(conversationID, userID)], nil
}
func (tx *interactionFakeTx) BotMemberActive(_ context.Context, _ string, conversationID, userID string) (bool, error) {
	return tx.state.botMembers[interactionMembershipKey(conversationID, userID)], nil
}
func (tx *interactionFakeTx) GetCommandRun(_ context.Context, spaceID, actorID, clientID string) (*CommandRunRecord, error) {
	run, ok := tx.state.commands[interactionCommandKey(spaceID, actorID, clientID)]
	if !ok {
		return nil, nil
	}
	copy := cloneCommandRun(run)
	return &copy, nil
}
func (tx *interactionFakeTx) GetWorkflow(_ context.Context, spaceID, workflowID string) (*WorkflowRecord, error) {
	workflow, ok := tx.state.workflows[workflowID]
	if !ok || workflow.SpaceID != spaceID {
		return nil, nil
	}
	copy := cloneWorkflow(workflow)
	return &copy, nil
}
func (tx *interactionFakeTx) GetWorkflowByInvocation(_ context.Context, spaceID, actorID, clientID string) (*WorkflowRecord, error) {
	workflow, ok := tx.state.workflows[interactionWorkflowInvocationKey(spaceID, actorID, clientID)]
	if !ok {
		return nil, nil
	}
	copy := cloneWorkflow(workflow)
	return &copy, nil
}
func (tx *interactionFakeTx) ListActiveWorkflows(_ context.Context, actorID, conversationID, botUserID string, limit int) ([]WorkflowRecord, error) {
	return listInteractionWorkflows(tx.state, actorID, conversationID, botUserID, limit), nil
}
func listInteractionWorkflows(state *interactionFakeState, actorID, conversationID, botUserID string, limit int) []WorkflowRecord {
	if limit < 1 {
		limit = 1
	}
	result := make([]WorkflowRecord, 0, limit)
	for _, workflow := range state.workflows {
		if workflow.ActorUserID == actorID && stringValue(workflow.ConversationID) == conversationID && stringValue(workflow.BotUserID) == botUserID && workflow.Status == "active" {
			result = append(result, cloneWorkflow(workflow))
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].UpdatedAt.Equal(result[j].UpdatedAt) {
			return result[i].ID > result[j].ID
		}
		return result[i].UpdatedAt.After(result[j].UpdatedAt)
	})
	if len(result) > limit {
		result = result[:limit]
	}
	return result
}

func (tx *interactionFakeTx) Lock(context.Context, string) error { return nil }
func (tx *interactionFakeTx) ConsumeRateLimit(_ context.Context, input RateLimitInput) (bool, time.Duration, error) {
	key := fmt.Sprintf("%s:%s:%s:%s:%s", input.SpaceID, input.ActorUserID, input.BotUserID, input.OperationKey, input.WindowStartedAt.UTC().Format(time.RFC3339))
	current := tx.state.rates[key]
	if current >= input.Limit {
		retry := input.WindowStartedAt.Add(RateLimitWindow).Sub(input.UpdatedAt)
		if retry < time.Second {
			retry = time.Second
		}
		return false, retry, nil
	}
	tx.state.rates[key] = current + 1
	return true, 0, nil
}
func (tx *interactionFakeTx) InsertCommandRun(_ context.Context, input CommandRunRecord) (*CommandRunRecord, bool, error) {
	key := interactionCommandKey(input.SpaceID, input.ActorUserID, input.ClientInvocationID)
	if _, exists := tx.state.commands[key]; exists {
		return nil, false, nil
	}
	copy := cloneCommandRun(input)
	tx.state.commands[key] = copy
	return &copy, true, nil
}
func (tx *interactionFakeTx) CompleteCommandRun(_ context.Context, id string, resultCardID *string, resultJSON []byte, at time.Time) error {
	for key, run := range tx.state.commands {
		if run.ID == id {
			run.Status = "succeeded"
			run.ResultCardID = cloneString(resultCardID)
			run.ResultJSON = append([]byte(nil), resultJSON...)
			run.CompletedAt = cloneTime(&at)
			tx.state.commands[key] = run
			return nil
		}
	}
	return errors.New("command run missing")
}
func (tx *interactionFakeTx) FailCommandRun(_ context.Context, id, code string, at time.Time) error {
	for key, run := range tx.state.commands {
		if run.ID == id {
			run.Status = "failed"
			run.ErrorCode = code
			run.CompletedAt = cloneTime(&at)
			tx.state.commands[key] = run
			return nil
		}
	}
	return errors.New("command run missing")
}
func (tx *interactionFakeTx) ExpireWorkflows(_ context.Context, actorID, conversationID, botUserID string, at time.Time) error {
	for key, workflow := range tx.state.workflows {
		if workflow.ActorUserID == actorID && stringValue(workflow.ConversationID) == conversationID && stringValue(workflow.BotUserID) == botUserID && workflow.Status == "active" && !workflow.ExpiresAt.After(at) {
			workflow.Status = "expired"
			workflow.Revision++
			workflow.UpdatedAt = at
			tx.state.workflows[key] = workflow
		}
	}
	return nil
}
func (tx *interactionFakeTx) InsertWorkflow(_ context.Context, input WorkflowRecord) (*WorkflowRecord, bool, error) {
	for _, workflow := range tx.state.workflows {
		if workflow.SpaceID == input.SpaceID && workflow.ActorUserID == input.ActorUserID && stringValue(workflow.ClientInvocationID) == stringValue(input.ClientInvocationID) {
			return nil, false, nil
		}
		if workflow.Status == "active" && input.Status == "active" && workflow.ActorUserID == input.ActorUserID && stringValue(workflow.ConversationID) == stringValue(input.ConversationID) && stringValue(workflow.BotUserID) == stringValue(input.BotUserID) {
			return nil, false, nil
		}
	}
	if _, exists := tx.state.workflows[input.ID]; exists {
		return nil, false, nil
	}
	copy := cloneWorkflow(input)
	tx.state.workflows[copy.ID] = copy
	if copy.ClientInvocationID != nil {
		tx.state.workflows[interactionWorkflowInvocationKey(copy.SpaceID, copy.ActorUserID, *copy.ClientInvocationID)] = copy
	}
	return &copy, true, nil
}
func (tx *interactionFakeTx) UpdateWorkflow(_ context.Context, id string, expectedRevision int64, state any, status string, at time.Time) (*WorkflowRecord, bool, error) {
	workflow, ok := tx.state.workflows[id]
	if !ok || workflow.Status != "active" || workflow.Revision != expectedRevision {
		return nil, false, nil
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		return nil, false, err
	}
	workflow.StateJSON = encoded
	workflow.Status = status
	workflow.Revision++
	workflow.UpdatedAt = at
	tx.state.workflows[id] = workflow
	if workflow.ClientInvocationID != nil {
		tx.state.workflows[interactionWorkflowInvocationKey(workflow.SpaceID, workflow.ActorUserID, *workflow.ClientInvocationID)] = workflow
	}
	copy := cloneWorkflow(workflow)
	return &copy, true, nil
}
func (tx *interactionFakeTx) WriteAudit(_ context.Context, input AuditInput) error {
	tx.state.audits = append(tx.state.audits, input)
	return nil
}
func (tx *interactionFakeTx) WriteEvent(_ context.Context, input EventInput) (EventRecord, error) {
	input.PayloadJSON = append([]byte(nil), input.PayloadJSON...)
	tx.state.events = append(tx.state.events, input)
	sequence := tx.state.sequence
	tx.state.sequence++
	return EventRecord{ID: input.ID, SpaceID: input.SpaceID, Seq: sequence}, nil
}

type interactionFixture struct {
	repo    *interactionFakeRepo
	service *Service
	now     time.Time
}

func newInteractionFixture(t *testing.T) *interactionFixture {
	t.Helper()
	state := newInteractionFakeState()
	for _, actor := range []*auth.Actor{
		{ID: "usr_owner", Kind: "human", Role: "owner", GitHubLogin: "owner"},
		{ID: "usr_member", Kind: "human", Role: "member", GitHubLogin: "member"},
		{ID: "usr_other", Kind: "human", Role: "member", GitHubLogin: "other"},
		{ID: "usr_bot", Kind: "bot", Role: "member", GitHubLogin: "bot"},
	} {
		state.actors[actor.ID] = actor
	}
	state.conversations["conv_test"] = ConversationRecord{ID: "conv_test", SpaceID: "spc_test", Type: "group"}
	for _, userID := range []string{"usr_owner", "usr_member", "usr_other", "usr_bot"} {
		state.conversationMembers[interactionMembershipKey("conv_test", userID)] = true
	}
	state.botMembers[interactionMembershipKey("conv_test", "usr_bot")] = true
	repo := &interactionFakeRepo{state: state}
	now := time.Date(2026, 9, 4, 12, 34, 56, 789000000, time.UTC)
	commands, err := NewCommandRegistry(
		CommandDefinition{
			Name:     "echo",
			Aliases:  []string{"say"},
			Contexts: []CommandContext{CommandContextDirect, CommandContextMention},
			ParseArguments: func(raw string) (any, error) {
				return map[string]any{"text": raw}, nil
			},
			Execute: func(_ context.Context, input CommandExecution) (CommandResult, error) {
				return CommandResult{Result: map[string]any{"echo": input.Arguments}}, nil
			},
		},
		CommandDefinition{
			Name: "deny",
			Authorize: func(context.Context, CommandAuthorization) (bool, error) {
				return false, nil
			},
			Execute: func(context.Context, CommandExecution) (CommandResult, error) {
				return CommandResult{Result: map[string]any{"unexpected": true}}, nil
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	workflows, err := NewWorkflowRegistry(WorkflowDefinition{
		Type:    "setup",
		Version: 1,
		Initialize: func(context.Context, WorkflowExecution) (WorkflowResult, error) {
			return WorkflowResult{State: map[string]any{"step": 0}}, nil
		},
		Continue: func(_ context.Context, input WorkflowExecution) (WorkflowResult, error) {
			state := input.State.(map[string]any)
			step, _ := interactionNumber(state["step"])
			done := false
			if values, ok := input.Input.(map[string]any); ok {
				done, _ = values["done"].(bool)
			}
			status := "active"
			if done {
				status = "completed"
			}
			return WorkflowResult{State: map[string]any{"step": step + 1}, Status: status, Result: map[string]any{"step": step + 1}}, nil
		},
		ValidateState: func(value any) (any, error) {
			object, ok := value.(map[string]any)
			if !ok {
				return nil, errors.New("workflow state must be an object")
			}
			return object, nil
		},
		Project: func(_ context.Context, input WorkflowProjectionContext) (any, error) {
			return input.State, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	sequence := 0
	var idMu sync.Mutex
	service := NewService(ServiceOptions{
		Repository:       repo,
		CommandRegistry:  commands,
		WorkflowRegistry: workflows,
		SpaceID:          "spc_test",
		Now:              func() time.Time { return now },
		IDFactory: func() (string, error) {
			idMu.Lock()
			defer idMu.Unlock()
			sequence++
			return fmt.Sprintf("id_%d", sequence), nil
		},
		RateLimits: RateLimits{Command: 1000, WorkflowStart: 1000, WorkflowContinue: 1000, WorkflowCancel: 1000},
	})
	return &interactionFixture{repo: repo, service: service, now: now}
}

func interactionNumber(value any) (int64, bool) {
	switch number := value.(type) {
	case int:
		return int64(number), true
	case int64:
		return number, true
	case float64:
		return int64(number), number == float64(int64(number))
	default:
		return 0, false
	}
}

func interactionRequest(id string) Request {
	return Request{Meta: auth.RequestMeta{RequestID: id, IPAddress: "198.51.100.4", UserAgent: "test-agent"}}
}

func interactionErrorCode(err error) string {
	var value *Error
	if errors.As(err, &value) {
		return value.Code
	}
	return ""
}

type testInfrastructureFailure struct{ cause error }

func (e *testInfrastructureFailure) Error() string {
	if e == nil || e.cause == nil {
		return "test infrastructure failure"
	}
	return e.cause.Error()
}

func (*testInfrastructureFailure) InteractionInfrastructureFailure() {}

func TestFailureDispositionPreservesOnlyTrustedExpectedRejections(t *testing.T) {
	expected := NewError("test.rejected", "rejected", 422)
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{name: "fourxx", err: expected, want: false},
		{name: "fourxx-join", err: errors.Join(expected, NewError("test.also_rejected", "rejected", 409)), want: false},
		{name: "fivexx", err: NewError("test.internal", "failed", 500), want: true},
		{name: "unknown", err: errors.New("database connection failed"), want: true},
		{name: "context-canceled", err: context.Canceled, want: true},
		{name: "card-validation", err: &cards.CardValidationError{Code: "card.invalid", Message: "invalid"}, want: false},
		{name: "joined-fourxx-unknown", err: errors.Join(expected, errors.New("savepoint release failed")), want: true},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if got := shouldRollback(test.err); got != test.want {
				t.Fatalf("shouldRollback(%v) = %v, want %v", test.err, got, test.want)
			}
		})
	}
}

func TestInfrastructureFailureWinsOverJoinedFourXXAndStaysOpaque(t *testing.T) {
	fourXX := NewError("test.rejected", "rejected", 422)
	joined := errors.Join(fourXX, &testInfrastructureFailure{cause: errors.New("savepoint release failed")})
	if !shouldRollback(joined) {
		t.Fatal("joined 4xx/infrastructure error was classified as a rejection")
	}
	wrapped := wrapInfrastructureFailure(joined, "test interaction")
	var leaked *Error
	if errors.As(wrapped, &leaked) {
		t.Fatalf("opaque infrastructure wrapper exposed nested error: %#v", leaked)
	}
	public := normalizeError(wrapped)
	if interactionErrorCode(public) != CodeInternal {
		t.Fatalf("normalized infrastructure code = %q, want %q", interactionErrorCode(public), CodeInternal)
	}
}

func TestExecuteCommandInfrastructureRollbackAndFourXXRejection(t *testing.T) {
	fixture := newInteractionFixture(t)
	registry, err := NewCommandRegistry(
		CommandDefinition{
			Name:     "infra-fault",
			Contexts: []CommandContext{CommandContextDirect, CommandContextMention},
			Execute: func(ctx context.Context, input CommandExecution) (CommandResult, error) {
				if _, err := input.Tx.WriteEvent(ctx, EventInput{SpaceID: input.Context.SpaceID, Type: "test.domain.written", ActorID: input.Actor.ID, ConversationID: input.Context.ID, TargetType: "test", TargetID: "infra"}); err != nil {
					return CommandResult{}, err
				}
				return CommandResult{}, errors.Join(NewError("test.rejected", "rejected", 422), &testInfrastructureFailure{cause: errors.New("late command failure")})
			},
		},
		CommandDefinition{
			Name:     "expected-reject",
			Contexts: []CommandContext{CommandContextDirect, CommandContextMention},
			Execute: func(context.Context, CommandExecution) (CommandResult, error) {
				return CommandResult{}, NewError("test.rejected", "rejected", 422)
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	fixture.service.commands = registry
	_, err = fixture.service.ExecuteCommand(context.Background(), ExecuteCommandInput{
		ActorID: "usr_owner", SpaceID: "spc_test", ConversationID: "conv_test", BotUserID: "usr_bot",
		Source: "/infra-fault", MentionedBotIDs: []string{"usr_bot"}, ClientInvocationID: "infra-command",
	})
	if interactionErrorCode(err) != CodeInternal {
		t.Fatalf("infrastructure command error = %v", err)
	}
	fixture.repo.mu.Lock()
	if len(fixture.repo.state.commands) != 0 || len(fixture.repo.state.events) != 0 || len(fixture.repo.state.audits) != 0 {
		t.Fatalf("infrastructure command left transaction state: commands=%d events=%d audits=%d", len(fixture.repo.state.commands), len(fixture.repo.state.events), len(fixture.repo.state.audits))
	}
	fixture.repo.mu.Unlock()

	_, err = fixture.service.ExecuteCommand(context.Background(), ExecuteCommandInput{
		ActorID: "usr_owner", SpaceID: "spc_test", ConversationID: "conv_test", BotUserID: "usr_bot",
		Source: "/expected-reject", MentionedBotIDs: []string{"usr_bot"}, ClientInvocationID: "expected-command",
	})
	if interactionErrorCode(err) != "test.rejected" {
		t.Fatalf("expected command rejection = %v", err)
	}
	fixture.repo.mu.Lock()
	defer fixture.repo.mu.Unlock()
	if len(fixture.repo.state.commands) != 1 || len(fixture.repo.state.events) != 0 || len(fixture.repo.state.audits) != 1 {
		t.Fatalf("expected command rejection state: commands=%d events=%d audits=%d", len(fixture.repo.state.commands), len(fixture.repo.state.events), len(fixture.repo.state.audits))
	}
	for _, run := range fixture.repo.state.commands {
		if run.Status != "failed" || run.ErrorCode != "test.rejected" {
			t.Fatalf("expected failed command run = %#v", run)
		}
	}
}

func TestContinueWorkflowInfrastructureRollbackAndFourXXRejection(t *testing.T) {
	newWorkflowRegistry := func(continueFn func(context.Context, WorkflowExecution) (WorkflowResult, error)) *WorkflowRegistry {
		registry, err := NewWorkflowRegistry(WorkflowDefinition{
			Type:    "failure-test",
			Version: 1,
			Initialize: func(context.Context, WorkflowExecution) (WorkflowResult, error) {
				return WorkflowResult{State: map[string]any{"step": 0}}, nil
			},
			Continue:      continueFn,
			ValidateState: func(value any) (any, error) { return value, nil },
			Project:       func(_ context.Context, input WorkflowProjectionContext) (any, error) { return input.State, nil },
		})
		if err != nil {
			panic(err)
		}
		return registry
	}

	fixture := newInteractionFixture(t)
	fixture.service.workflows = newWorkflowRegistry(func(ctx context.Context, input WorkflowExecution) (WorkflowResult, error) {
		if _, err := input.Tx.WriteEvent(ctx, EventInput{SpaceID: input.Context.SpaceID, Type: "test.domain.written", ActorID: input.Actor.ID, ConversationID: input.Context.ID, TargetType: "test", TargetID: "infra"}); err != nil {
			return WorkflowResult{}, err
		}
		return WorkflowResult{}, errors.Join(NewError("test.rejected", "rejected", 422), &testInfrastructureFailure{cause: errors.New("late workflow failure")})
	})
	started, err := fixture.service.StartWorkflow(context.Background(), StartWorkflowInput{
		ActorID: "usr_owner", SpaceID: "spc_test", ConversationID: "conv_test", BotUserID: "usr_bot", Type: "failure-test", Version: 1, ClientInvocationID: "infra-workflow",
	})
	if err != nil {
		t.Fatal(err)
	}
	fixture.repo.mu.Lock()
	baselineAudits := len(fixture.repo.state.audits)
	baselineEvents := len(fixture.repo.state.events)
	fixture.repo.mu.Unlock()
	_, err = fixture.service.ContinueWorkflow(context.Background(), "usr_owner", ContinueWorkflowInput{WorkflowID: started.ID, ExpectedRevision: 1})
	if interactionErrorCode(err) != CodeInternal {
		t.Fatalf("infrastructure workflow error = %v", err)
	}
	fixture.repo.mu.Lock()
	workflow := fixture.repo.state.workflows[started.ID]
	if workflow.Status != "active" || workflow.Revision != 1 || len(fixture.repo.state.events) != baselineEvents || len(fixture.repo.state.audits) != baselineAudits {
		t.Fatalf("infrastructure workflow left state: workflow=%#v events=%d audits=%d", workflow, len(fixture.repo.state.events), len(fixture.repo.state.audits))
	}
	fixture.repo.mu.Unlock()

	fixture = newInteractionFixture(t)
	fixture.service.workflows = newWorkflowRegistry(func(context.Context, WorkflowExecution) (WorkflowResult, error) {
		return WorkflowResult{}, NewError("test.rejected", "rejected", 422)
	})
	started, err = fixture.service.StartWorkflow(context.Background(), StartWorkflowInput{
		ActorID: "usr_owner", SpaceID: "spc_test", ConversationID: "conv_test", BotUserID: "usr_bot", Type: "failure-test", Version: 1, ClientInvocationID: "expected-workflow",
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = fixture.service.ContinueWorkflow(context.Background(), "usr_owner", ContinueWorkflowInput{WorkflowID: started.ID, ExpectedRevision: 1})
	if interactionErrorCode(err) != "test.rejected" {
		t.Fatalf("expected workflow rejection = %v", err)
	}
	fixture.repo.mu.Lock()
	defer fixture.repo.mu.Unlock()
	workflow = fixture.repo.state.workflows[started.ID]
	if workflow.Status != "active" || workflow.Revision != 1 || len(fixture.repo.state.events) != 1 || len(fixture.repo.state.audits) != 2 {
		t.Fatalf("expected workflow rejection state: workflow=%#v events=%d audits=%d", workflow, len(fixture.repo.state.events), len(fixture.repo.state.audits))
	}
}

func TestCommandRegistryRecognitionAndTriggerScope(t *testing.T) {
	fixture := newInteractionFixture(t)
	if recognized, err := fixture.service.commands.Recognize("/echo hello", RecognitionContext{ConversationType: "group", BotUserID: "usr_bot"}); err != nil || recognized != nil {
		t.Fatalf("unmentioned group command = %#v, err=%v", recognized, err)
	}
	recognized, err := fixture.service.commands.Recognize("/ECHO hello", RecognitionContext{ConversationType: "group", BotUserID: "usr_bot", MentionedBotIDs: []string{"usr_bot"}})
	if err != nil || recognized == nil || recognized.Name != "echo" {
		t.Fatalf("mentioned command = %#v, err=%v", recognized, err)
	}
	recognized, err = fixture.service.commands.Recognize("/say direct", RecognitionContext{ConversationType: "direct", BotUserID: "usr_bot"})
	if err != nil || recognized == nil || recognized.Name != "echo" {
		t.Fatalf("alias command = %#v, err=%v", recognized, err)
	}
	recognized, err = fixture.service.commands.Recognize("/missing", RecognitionContext{ConversationType: "direct", BotUserID: "usr_bot"})
	if err != nil || recognized == nil || recognized.Type != "unknown_command" {
		t.Fatalf("unknown command = %#v, err=%v", recognized, err)
	}
}

func TestCommandExecutionIdempotencyAuthorizationAuditAndEvents(t *testing.T) {
	fixture := newInteractionFixture(t)
	input := ExecuteCommandInput{ActorID: "usr_owner", SpaceID: "spc_test", ConversationID: "conv_test", BotUserID: "usr_bot", Source: "/echo hello", MentionedBotIDs: []string{"usr_bot"}, ClientInvocationID: "invoke-1", Request: interactionRequest("command-1")}
	first, err := fixture.service.ExecuteCommand(context.Background(), input)
	if err != nil || !first.OK || first.Replayed {
		t.Fatalf("first command = %#v, err=%v", first, err)
	}
	replay, err := fixture.service.ExecuteCommand(context.Background(), input)
	if err != nil || !replay.OK || !replay.Replayed {
		t.Fatalf("replayed command = %#v, err=%v", replay, err)
	}
	conflict := input
	conflict.Source = "/echo different"
	if _, err := fixture.service.ExecuteCommand(context.Background(), conflict); interactionErrorCode(err) != CodeCommandIdempotencyConflict {
		t.Fatalf("command idempotency error = %v", err)
	}
	denied := input
	denied.Source = "/deny"
	denied.ClientInvocationID = "invoke-denied"
	if _, err := fixture.service.ExecuteCommand(context.Background(), denied); interactionErrorCode(err) != CodePermissionDenied {
		t.Fatalf("denied command error = %v", err)
	}
	if _, err := fixture.service.ExecuteCommand(context.Background(), ExecuteCommandInput{ActorID: "usr_owner", SpaceID: "spc_test", ConversationID: "conv_test", BotUserID: "usr_bot", Source: "ordinary text", MentionedBotIDs: []string{"usr_bot"}, ClientInvocationID: "invoke-none"}); interactionErrorCode(err) != CodeCommandNotTriggered {
		t.Fatalf("not triggered error = %v", err)
	}
	if _, err := fixture.service.ExecuteCommand(context.Background(), ExecuteCommandInput{ActorID: "usr_owner", SpaceID: "spc_test", ConversationID: "conv_test", BotUserID: "usr_bot", Source: "/missing", MentionedBotIDs: []string{"usr_bot"}, ClientInvocationID: "invoke-unknown"}); interactionErrorCode(err) != CodeCommandUnknown {
		t.Fatalf("unknown error = %v", err)
	}

	fixture.repo.mu.Lock()
	defer fixture.repo.mu.Unlock()
	if len(fixture.repo.state.commands) != 2 {
		t.Fatalf("command run count = %d", len(fixture.repo.state.commands))
	}
	if len(fixture.repo.state.events) != 1 || fixture.repo.state.events[0].Type != "command.invoked" {
		t.Fatalf("events = %#v", fixture.repo.state.events)
	}
	for _, audit := range fixture.repo.state.audits {
		if audit.Reason != "" && audit.Reason != CodePermissionDenied && audit.Reason != CodeCommandIdempotencyConflict {
			t.Fatalf("unexpected audit reason = %#v", audit)
		}
	}
	for _, event := range fixture.repo.state.events {
		if string(event.PayloadJSON) == "/echo hello" || string(event.PayloadJSON) == "hello" {
			t.Fatal("command source leaked into event")
		}
	}
}

func TestCommandConcurrentInvocationIsSingleExecution(t *testing.T) {
	fixture := newInteractionFixture(t)
	input := ExecuteCommandInput{ActorID: "usr_owner", SpaceID: "spc_test", ConversationID: "conv_test", BotUserID: "usr_bot", Source: "/echo concurrent", MentionedBotIDs: []string{"usr_bot"}, ClientInvocationID: "invoke-concurrent"}
	const count = 16
	results := make(chan error, count)
	var wait sync.WaitGroup
	for i := 0; i < count; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, err := fixture.service.ExecuteCommand(context.Background(), input)
			results <- err
		}()
	}
	wait.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatalf("concurrent command error = %v", err)
		}
	}
	fixture.repo.mu.Lock()
	defer fixture.repo.mu.Unlock()
	if len(fixture.repo.state.commands) != 1 || len(fixture.repo.state.events) != 1 {
		t.Fatalf("commands=%d events=%d", len(fixture.repo.state.commands), len(fixture.repo.state.events))
	}
}

func TestWorkflowLifecycleIdempotencyRevisionExpiryAndAudit(t *testing.T) {
	fixture := newInteractionFixture(t)
	input := StartWorkflowInput{ActorID: "usr_owner", SpaceID: "spc_test", ConversationID: "conv_test", BotUserID: "usr_bot", Type: "setup", Version: 1, Input: map[string]any{"source": "button"}, ClientInvocationID: "workflow-1", Request: interactionRequest("workflow-start")}
	started, err := fixture.service.StartWorkflow(context.Background(), input)
	if err != nil || started.Status != "active" || started.Revision != 1 {
		t.Fatalf("started = %#v, err=%v", started, err)
	}
	if started.CreatedAt != "2026-09-04T12:34:56.789Z" || started.ExpiresAt != "2026-09-04T13:04:56.789Z" {
		t.Fatalf("timestamps = %#v", started)
	}
	replay, err := fixture.service.StartWorkflow(context.Background(), input)
	if err != nil || replay.ID != started.ID {
		t.Fatalf("workflow replay = %#v, err=%v", replay, err)
	}
	other := input
	other.ClientInvocationID = "workflow-2"
	if _, err := fixture.service.StartWorkflow(context.Background(), other); interactionErrorCode(err) != CodeWorkflowActiveConflict {
		t.Fatalf("active conflict = %v", err)
	}
	continued, err := fixture.service.ContinueWorkflow(context.Background(), "usr_owner", ContinueWorkflowInput{WorkflowID: started.ID, ExpectedRevision: 1, Input: map[string]any{"done": false}, Request: interactionRequest("workflow-continue")})
	if err != nil || continued.Workflow.Revision != 2 || continued.Workflow.Status != "active" {
		t.Fatalf("continued = %#v, err=%v", continued, err)
	}
	if _, err := fixture.service.ContinueWorkflow(context.Background(), "usr_owner", ContinueWorkflowInput{WorkflowID: started.ID, ExpectedRevision: 1}); interactionErrorCode(err) != CodeWorkflowStaleRevision {
		t.Fatalf("stale workflow error = %v", err)
	}
	completed, err := fixture.service.ContinueWorkflow(context.Background(), "usr_owner", ContinueWorkflowInput{WorkflowID: started.ID, ExpectedRevision: 2, Input: map[string]any{"done": true}})
	if err != nil || completed.Workflow.Status != "completed" || completed.Workflow.Revision != 3 {
		t.Fatalf("completed = %#v, err=%v", completed, err)
	}
	if _, err := fixture.service.ContinueWorkflow(context.Background(), "usr_owner", ContinueWorkflowInput{WorkflowID: started.ID, ExpectedRevision: 3}); interactionErrorCode(err) != CodeWorkflowNotActive {
		t.Fatalf("completed continuation error = %v", err)
	}
	fixture.repo.mu.Lock()
	defer fixture.repo.mu.Unlock()
	if len(fixture.repo.state.events) != 3 {
		t.Fatalf("workflow event count = %d", len(fixture.repo.state.events))
	}
	if len(fixture.repo.state.audits) < 5 {
		t.Fatalf("workflow audit count = %d", len(fixture.repo.state.audits))
	}
}

func TestGetWorkflowRechecksConversationAndBotMembership(t *testing.T) {
	fixture := newInteractionFixture(t)
	started, err := fixture.service.StartWorkflow(context.Background(), StartWorkflowInput{ActorID: "usr_owner", SpaceID: "spc_test", ConversationID: "conv_test", BotUserID: "usr_bot", Type: "setup", Version: 1, ClientInvocationID: "workflow-membership"})
	if err != nil {
		t.Fatal(err)
	}
	fixture.repo.mu.Lock()
	fixture.repo.state.conversationMembers[interactionMembershipKey("conv_test", "usr_owner")] = false
	fixture.repo.mu.Unlock()
	if _, err := fixture.service.GetWorkflow(context.Background(), "usr_owner", started.ID); interactionErrorCode(err) != CodeConversationNotFound {
		t.Fatalf("revoked conversation membership error = %v", err)
	}

	fixture.repo.mu.Lock()
	fixture.repo.state.conversationMembers[interactionMembershipKey("conv_test", "usr_owner")] = true
	fixture.repo.state.botMembers[interactionMembershipKey("conv_test", "usr_bot")] = false
	fixture.repo.mu.Unlock()
	if _, err := fixture.service.GetWorkflow(context.Background(), "usr_owner", started.ID); interactionErrorCode(err) != CodeBotNotAvailable {
		t.Fatalf("revoked bot membership error = %v", err)
	}
}

func TestWorkflowExpiryInvalidStatusAndCancel(t *testing.T) {
	fixture := newInteractionFixture(t)
	start := StartWorkflowInput{ActorID: "usr_owner", SpaceID: "spc_test", ConversationID: "conv_test", BotUserID: "usr_bot", Type: "setup", Version: 1, TTL: time.Minute, ClientInvocationID: "workflow-expiry"}
	started, err := fixture.service.StartWorkflow(context.Background(), start)
	if err != nil {
		t.Fatal(err)
	}
	fixture.now = fixture.now.Add(2 * time.Minute)
	fixture.service.now = func() time.Time { return fixture.now }
	if _, err := fixture.service.ContinueWorkflow(context.Background(), "usr_owner", ContinueWorkflowInput{WorkflowID: started.ID, ExpectedRevision: 1}); interactionErrorCode(err) != CodeWorkflowExpired {
		t.Fatalf("expiry error = %v", err)
	}
	if _, err := fixture.service.ContinueWorkflow(context.Background(), "usr_owner", ContinueWorkflowInput{WorkflowID: started.ID, ExpectedRevision: 1}); interactionErrorCode(err) != CodeWorkflowNotActive {
		t.Fatalf("expired retry error = %v", err)
	}

	fixture = newInteractionFixture(t)
	badStatus := fixture.service.workflows.Get("setup", 1)
	badDefinition := *badStatus
	badDefinition.Initialize = func(ctx context.Context, execution WorkflowExecution) (WorkflowResult, error) {
		if _, err := execution.Tx.WriteEvent(ctx, EventInput{SpaceID: "spc_test", Type: "test.initialize.domain_written", ActorID: "usr_owner"}); err != nil {
			return WorkflowResult{}, err
		}
		return WorkflowResult{State: map[string]any{"step": 0}, Status: "unknown"}, nil
	}
	registry, err := NewWorkflowRegistry(badDefinition)
	if err != nil {
		t.Fatal(err)
	}
	fixture.service.workflows = registry
	if _, err := fixture.service.StartWorkflow(context.Background(), StartWorkflowInput{ActorID: "usr_owner", SpaceID: "spc_test", ConversationID: "conv_test", BotUserID: "usr_bot", Type: "setup", Version: 1, ClientInvocationID: "workflow-bad-status"}); interactionErrorCode(err) != CodeInternal {
		t.Fatalf("invalid status error = %v", err)
	}
	if len(fixture.repo.state.events) != 0 || len(fixture.repo.state.audits) != 0 || len(fixture.repo.state.workflows) != 0 {
		t.Fatal("invalid generated workflow status committed partial state")
	}

	fixture = newInteractionFixture(t)
	started, err = fixture.service.StartWorkflow(context.Background(), StartWorkflowInput{ActorID: "usr_owner", SpaceID: "spc_test", ConversationID: "conv_test", BotUserID: "usr_bot", Type: "setup", Version: 1, ClientInvocationID: "workflow-cancel"})
	if err != nil {
		t.Fatal(err)
	}
	cancelled, err := fixture.service.CancelWorkflow(context.Background(), "usr_owner", CancelWorkflowInput{WorkflowID: started.ID})
	if err != nil || cancelled.Status != "cancelled" || cancelled.Revision != 2 {
		t.Fatalf("cancelled = %#v, err=%v", cancelled, err)
	}
	if _, err := fixture.service.CancelWorkflow(context.Background(), "usr_owner", CancelWorkflowInput{WorkflowID: started.ID}); interactionErrorCode(err) != CodeWorkflowNotActive {
		t.Fatalf("cancel retry error = %v", err)
	}
}

func TestCancelWorkflowInTxUsesCallerTransactionForCurrentAuthorization(t *testing.T) {
	fixture := newInteractionFixture(t)
	started, err := fixture.service.StartWorkflow(context.Background(), StartWorkflowInput{
		ActorID: "usr_owner", SpaceID: "spc_test", ConversationID: "conv_test", BotUserID: "usr_bot",
		Type: "setup", Version: 1, ClientInvocationID: "workflow-cancel-in-tx",
	})
	if err != nil {
		t.Fatal(err)
	}
	err = fixture.repo.WithTx(context.Background(), func(tx Tx) error {
		fakeTx, ok := tx.(*interactionFakeTx)
		if !ok {
			return errors.New("unexpected interaction transaction type")
		}
		fakeTx.state.conversationMembers[interactionMembershipKey("conv_test", "usr_owner")] = false
		_, cancelErr := fixture.service.CancelWorkflowInTx(context.Background(), tx, "usr_owner", CancelWorkflowInput{
			WorkflowID: started.ID, SpaceID: "spc_test", ConversationID: "conv_test", BotUserID: "usr_bot",
		})
		return cancelErr
	})
	var rejection *TransactionRejection
	if !errors.As(err, &rejection) || rejection == nil {
		t.Fatalf("cancel rejection = %v (%T)", err, err)
	}
	if interactionErrorCode(err) != CodeConversationNotFound {
		t.Fatalf("cancel rejection code = %q", interactionErrorCode(err))
	}
	fixture.repo.mu.Lock()
	defer fixture.repo.mu.Unlock()
	if fixture.repo.state.workflows[started.ID].Status != "active" || fixture.repo.state.workflows[started.ID].Revision != 1 {
		t.Fatalf("rejected cancellation changed workflow = %#v", fixture.repo.state.workflows[started.ID])
	}
}

func TestInteractionPublicWorkflowJSONUsesMillisecondTimestamps(t *testing.T) {
	fixture := newInteractionFixture(t)
	workflow, err := fixture.service.StartWorkflow(context.Background(), StartWorkflowInput{ActorID: "usr_owner", SpaceID: "spc_test", ConversationID: "conv_test", BotUserID: "usr_bot", Type: "setup", Version: 1, ClientInvocationID: "workflow-json"})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(workflow)
	if err != nil {
		t.Fatal(err)
	}
	if !json.Valid(encoded) || string(encoded) == "null" {
		t.Fatalf("workflow JSON = %s", encoded)
	}
	for _, field := range []string{"createdAt", "updatedAt", "expiresAt"} {
		if !containsJSONFieldSuffix(encoded, field, ".789Z") && field != "expiresAt" {
			t.Fatalf("missing millisecond timestamp %s in %s", field, encoded)
		}
	}
}

func containsJSONFieldSuffix(encoded []byte, field, suffix string) bool {
	var value map[string]any
	if json.Unmarshal(encoded, &value) != nil {
		return false
	}
	text, ok := value[field].(string)
	return ok && len(text) >= len(suffix) && text[len(text)-len(suffix):] == suffix
}
