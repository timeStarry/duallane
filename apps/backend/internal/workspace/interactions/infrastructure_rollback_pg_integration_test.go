//go:build postgres_integration

package interactions

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

type pgFailureRepository struct {
	*PGRepository
	mode          string
	lateEventType string
}

func (r *pgFailureRepository) WithTx(ctx context.Context, callback func(Tx) error) error {
	if r == nil || r.PGRepository == nil || r.pool == nil {
		return errors.New("test PostgreSQL repository is unavailable")
	}
	transaction, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = transaction.Rollback(context.Background())
		}
	}()
	base := r.PGRepository.NewTransaction(transaction)
	if base == nil {
		return errors.New("test PostgreSQL interaction transaction is unavailable")
	}
	if err := callback(&pgFailureTx{Tx: base, raw: transaction, mode: r.mode, lateEventType: r.lateEventType}); err != nil {
		return err
	}
	if err := transaction.Commit(ctx); err != nil {
		return err
	}
	committed = true
	return nil
}

type pgFailureTx struct {
	Tx
	raw           pgx.Tx
	mode          string
	lateEventType string
}

func (t *pgFailureTx) WriteEvent(ctx context.Context, input EventInput) (EventRecord, error) {
	if t.lateEventType != "" && input.Type == t.lateEventType {
		return EventRecord{}, errors.New("synthetic late event failure")
	}
	return t.Tx.WriteEvent(ctx, input)
}

func (t *pgFailureTx) WithTestSavepoint(ctx context.Context, callback func(context.Context) error) error {
	const name = "interaction_failure_rehearsal"
	if _, err := t.raw.Exec(ctx, "SAVEPOINT "+name); err != nil {
		return &testInfrastructureFailure{cause: err}
	}
	callbackErr := callback(ctx)
	if callbackErr != nil {
		if t.mode == "rollback-failure" {
			_, _ = t.raw.Exec(ctx, "ROLLBACK TO SAVEPOINT interaction_failure_missing")
			return errors.Join(callbackErr, &testInfrastructureFailure{cause: errors.New("synthetic savepoint rollback failure")})
		}
		if _, err := t.raw.Exec(ctx, "ROLLBACK TO SAVEPOINT "+name); err != nil {
			return errors.Join(callbackErr, &testInfrastructureFailure{cause: err})
		}
		if _, err := t.raw.Exec(ctx, "RELEASE SAVEPOINT "+name); err != nil {
			return errors.Join(callbackErr, &testInfrastructureFailure{cause: err})
		}
		return callbackErr
	}
	if t.mode == "release-failure" {
		_, _ = t.raw.Exec(ctx, "RELEASE SAVEPOINT interaction_failure_missing")
		return &testInfrastructureFailure{cause: errors.New("synthetic savepoint release failure")}
	}
	if _, err := t.raw.Exec(ctx, "RELEASE SAVEPOINT "+name); err != nil {
		return &testInfrastructureFailure{cause: err}
	}
	return nil
}

type testSavepointProvider interface {
	WithTestSavepoint(context.Context, func(context.Context) error) error
}

func newPGFailureService(t *testing.T, fixture *pgInteractionIntegrationFixture, mode, lateEventType string) *Service {
	t.Helper()
	var sequence atomic.Int64
	idFactory := func() (string, error) {
		return fmt.Sprintf("interaction-failure-%03d", sequence.Add(1)), nil
	}
	repository := &pgFailureRepository{
		PGRepository:  NewPGRepository(fixture.pool, idFactory),
		mode:          mode,
		lateEventType: lateEventType,
	}
	commands, err := NewCommandRegistry(CommandDefinition{
		Name:     "failure",
		Contexts: []CommandContext{CommandContextDirect, CommandContextMention},
		Execute: func(ctx context.Context, input CommandExecution) (CommandResult, error) {
			provider, ok := input.Tx.(testSavepointProvider)
			if !ok {
				return CommandResult{}, errors.New("test savepoint provider is unavailable")
			}
			err := provider.WithTestSavepoint(ctx, func(savepointCtx context.Context) error {
				_, writeErr := input.Tx.WriteEvent(savepointCtx, EventInput{
					SpaceID: input.Context.SpaceID, Type: "test.command.domain_written", ActorID: input.Actor.ID,
					ConversationID: input.Context.ID, TargetType: "test", TargetID: "command-domain",
				})
				if writeErr != nil {
					return writeErr
				}
				if mode == "expected" || mode == "rollback-failure" {
					return NewError("test.rejected", "synthetic rejection", 422)
				}
				return nil
			})
			if err != nil {
				return CommandResult{}, err
			}
			if mode == "opaque-leaf" {
				return CommandResult{}, opaqueLeaf{}
			}
			if mode == "invalid-output" {
				return CommandResult{Result: map[string]any{"invalid": make(chan int)}}, nil
			}
			return CommandResult{Result: map[string]any{"ok": true}}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	workflows, err := NewWorkflowRegistry(WorkflowDefinition{
		Type:    "failure-test",
		Version: 1,
		Initialize: func(context.Context, WorkflowExecution) (WorkflowResult, error) {
			return WorkflowResult{State: map[string]any{"step": 0}}, nil
		},
		Continue: func(ctx context.Context, input WorkflowExecution) (WorkflowResult, error) {
			provider, ok := input.Tx.(testSavepointProvider)
			if !ok {
				return WorkflowResult{}, errors.New("test savepoint provider is unavailable")
			}
			err := provider.WithTestSavepoint(ctx, func(savepointCtx context.Context) error {
				_, writeErr := input.Tx.WriteEvent(savepointCtx, EventInput{
					SpaceID: input.Context.SpaceID, Type: "test.workflow.domain_written", ActorID: input.Actor.ID,
					ConversationID: input.Context.ID, TargetType: "test", TargetID: "workflow-domain",
				})
				if writeErr != nil {
					return writeErr
				}
				if mode == "expected" || mode == "rollback-failure" {
					return NewError("test.rejected", "synthetic rejection", 422)
				}
				return nil
			})
			if err != nil {
				return WorkflowResult{}, err
			}
			if mode == "invalid-output" {
				return WorkflowResult{State: map[string]any{"step": 1}, Status: "completed", Result: map[string]any{"invalid": make(chan int)}}, nil
			}
			return WorkflowResult{State: map[string]any{"step": 1}, Status: "completed", Result: map[string]any{"ok": true}}, nil
		},
		ValidateState: func(value any) (any, error) { return value, nil },
		Project:       func(_ context.Context, input WorkflowProjectionContext) (any, error) { return input.State, nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	return NewService(ServiceOptions{
		Repository: repository, CommandRegistry: commands, WorkflowRegistry: workflows,
		SpaceID: DefaultSpaceID, Now: func() time.Time { return fixture.now }, IDFactory: idFactory,
		RateLimits: RateLimits{Command: 1000, WorkflowStart: 1000, WorkflowContinue: 1000, WorkflowCancel: 1000},
	})
}

func TestPGInteractionSavepointInfrastructureFailuresRollbackOuterTransaction(t *testing.T) {
	for _, test := range []struct {
		name          string
		mode          string
		lateEventType string
	}{
		{name: "command-late-event", mode: "late", lateEventType: "command.invoked"},
		{name: "workflow-late-event", mode: "late", lateEventType: "workflow.continued"},
		{name: "command-savepoint-rollback", mode: "rollback-failure"},
		{name: "command-empty-unwrap", mode: "opaque-leaf"},
		{name: "command-invalid-output", mode: "invalid-output"},
		{name: "workflow-invalid-output", mode: "invalid-output"},
		{name: "workflow-savepoint-release", mode: "release-failure"},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newPGInteractionIntegrationFixture(t)
			service := newPGFailureService(t, fixture, test.mode, test.lateEventType)
			if strings.HasPrefix(test.name, "command-") {
				_, err := service.ExecuteCommand(fixture.ctx, ExecuteCommandInput{
					ActorID: "usr_interaction_owner", SpaceID: DefaultSpaceID, ConversationID: "conv-interactions", BotUserID: "usr_interaction_bot",
					Source: "/failure", MentionedBotIDs: []string{"usr_interaction_bot"}, ClientInvocationID: "failure-command", Request: Request{Meta: authRequestMeta("failure-command")},
				})
				if pgInteractionErrorCode(err) != CodeInternal {
					t.Fatalf("command infrastructure error = %v", err)
				}
				if got := pgInteractionCount(t, fixture, `SELECT COUNT(*) FROM workspace_command_runs WHERE client_invocation_id = 'failure-command'`); got != 0 {
					t.Fatalf("rolled back command runs = %d", got)
				}
				if got := pgInteractionCount(t, fixture, `SELECT COUNT(*) FROM workspace_events WHERE type = 'test.command.domain_written' OR type = 'command.invoked'`); got != 0 {
					t.Fatalf("rolled back command events = %d", got)
				}
				return
			}

			workflow, err := service.StartWorkflow(fixture.ctx, StartWorkflowInput{
				ActorID: "usr_interaction_owner", SpaceID: DefaultSpaceID, ConversationID: "conv-interactions", BotUserID: "usr_interaction_bot",
				Type: "failure-test", Version: 1, ClientInvocationID: "failure-workflow-start", Request: Request{Meta: authRequestMeta("failure-workflow-start")},
			})
			if err != nil {
				t.Fatal(err)
			}
			_, err = service.ContinueWorkflow(fixture.ctx, "usr_interaction_owner", ContinueWorkflowInput{WorkflowID: workflow.ID, ExpectedRevision: 1, Request: Request{Meta: authRequestMeta("failure-workflow-continue")}})
			if pgInteractionErrorCode(err) != CodeInternal {
				t.Fatalf("workflow infrastructure error = %v", err)
			}
			var status string
			var revision int64
			if err := fixture.pool.QueryRow(fixture.ctx, `SELECT status, revision FROM workspace_workflow_sessions WHERE id = $1`, workflow.ID).Scan(&status, &revision); err != nil {
				t.Fatal(err)
			}
			if status != "active" || revision != 1 {
				t.Fatalf("workflow partial state = %s/%d", status, revision)
			}
			if got := pgInteractionCount(t, fixture, `SELECT COUNT(*) FROM workspace_events WHERE type = 'test.workflow.domain_written' OR type = 'workflow.continued'`); got != 0 {
				t.Fatalf("rolled back workflow events = %d", got)
			}
		})
	}
}

func TestPGInteractionExpectedFourXXKeepsRejectionEvidenceWithoutDomainPartialWrite(t *testing.T) {
	fixture := newPGInteractionIntegrationFixture(t)
	service := newPGFailureService(t, fixture, "expected", "")
	_, err := service.ExecuteCommand(fixture.ctx, ExecuteCommandInput{
		ActorID: "usr_interaction_owner", SpaceID: DefaultSpaceID, ConversationID: "conv-interactions", BotUserID: "usr_interaction_bot",
		Source: "/failure", MentionedBotIDs: []string{"usr_interaction_bot"}, ClientInvocationID: "expected-command", Request: Request{Meta: authRequestMeta("expected-command")},
	})
	if pgInteractionErrorCode(err) != "test.rejected" {
		t.Fatalf("expected command rejection = %v", err)
	}
	if got := pgInteractionCount(t, fixture, `SELECT COUNT(*) FROM workspace_command_runs WHERE client_invocation_id = 'expected-command' AND status = 'failed'`); got != 1 {
		t.Fatalf("failed command run count = %d", got)
	}
	if got := pgInteractionCount(t, fixture, `SELECT COUNT(*) FROM workspace_events WHERE type = 'test.command.domain_written'`); got != 0 {
		t.Fatalf("rejected command domain events = %d", got)
	}
	if got := pgInteractionCount(t, fixture, `SELECT COUNT(*) FROM audit_logs WHERE action = 'command.failure' AND result = 'rejected' AND request_id = 'expected-command'`); got != 1 {
		t.Fatalf("rejection audit count = %d", got)
	}

	fixture = newPGInteractionIntegrationFixture(t)
	service = newPGFailureService(t, fixture, "expected", "")
	workflow, err := service.StartWorkflow(fixture.ctx, StartWorkflowInput{
		ActorID: "usr_interaction_owner", SpaceID: DefaultSpaceID, ConversationID: "conv-interactions", BotUserID: "usr_interaction_bot",
		Type: "failure-test", Version: 1, ClientInvocationID: "expected-workflow-start", Request: Request{Meta: authRequestMeta("expected-workflow-start")},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.ContinueWorkflow(fixture.ctx, "usr_interaction_owner", ContinueWorkflowInput{WorkflowID: workflow.ID, ExpectedRevision: 1, Request: Request{Meta: authRequestMeta("expected-workflow-continue")}})
	if pgInteractionErrorCode(err) != "test.rejected" {
		t.Fatalf("expected workflow rejection = %v", err)
	}
	var status string
	var revision int64
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT status, revision FROM workspace_workflow_sessions WHERE id = $1`, workflow.ID).Scan(&status, &revision); err != nil {
		t.Fatal(err)
	}
	if status != "active" || revision != 1 {
		t.Fatalf("rejected workflow state = %s/%d", status, revision)
	}
	if got := pgInteractionCount(t, fixture, `SELECT COUNT(*) FROM workspace_events WHERE type = 'test.workflow.domain_written'`); got != 0 {
		t.Fatalf("rejected workflow domain events = %d", got)
	}
	if got := pgInteractionCount(t, fixture, `SELECT COUNT(*) FROM audit_logs WHERE action = 'workflow.continue' AND result = 'rejected' AND request_id = 'expected-workflow-continue'`); got != 1 {
		t.Fatalf("workflow rejection audit count = %d", got)
	}
}
