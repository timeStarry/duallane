//go:build postgres_integration

package interactions

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	platformmigrations "github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type pgInteractionIntegrationFixture struct {
	ctx     context.Context
	pool    *pgxpool.Pool
	service *Service
	now     time.Time
}

func newPGInteractionIntegrationFixture(t *testing.T) *pgInteractionIntegrationFixture {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })

	schema := fmt.Sprintf("duallane_interactions_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = conn.Exec(cleanupCtx, "DROP SCHEMA IF EXISTS "+identifier+" CASCADE")
	})
	if _, err := conn.Exec(ctx, "SET search_path TO "+identifier); err != nil {
		t.Fatal(err)
	}
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	migrationDirectory := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../web/server/migrations"))
	if _, err := (platformmigrations.Runner{Beginner: platformpostgres.NewMigrationBeginner(conn), Directory: migrationDirectory}).Run(ctx); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 4, 12, 34, 56, 789654321, time.UTC)
	seedPGInteractionIntegrationData(t, ctx, conn, now)
	poolConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	poolConfig.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	commands, err := NewCommandRegistry(CommandDefinition{
		Name:     "echo",
		Contexts: []CommandContext{CommandContextDirect, CommandContextMention},
		ParseArguments: func(raw string) (any, error) {
			return map[string]any{"text": raw}, nil
		},
		Execute: func(_ context.Context, input CommandExecution) (CommandResult, error) {
			return CommandResult{Result: map[string]any{"echo": input.Arguments}}, nil
		},
	})
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
			step, _ := pgInteractionNumber(state["step"])
			return WorkflowResult{State: map[string]any{"step": step + 1}, Status: "completed", Result: map[string]any{"step": step + 1}}, nil
		},
		ValidateState: func(value any) (any, error) {
			if _, ok := value.(map[string]any); !ok {
				return nil, errors.New("workflow state must be an object")
			}
			return value, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	var sequence atomic.Int64
	idFactory := func() (string, error) {
		return fmt.Sprintf("interaction-integration-%03d", sequence.Add(1)), nil
	}
	return &pgInteractionIntegrationFixture{ctx: ctx, pool: pool, now: now, service: NewService(ServiceOptions{Repository: NewPGRepository(pool, idFactory), CommandRegistry: commands, WorkflowRegistry: workflows, SpaceID: DefaultSpaceID, Now: func() time.Time { return now }, IDFactory: idFactory})}
}

func seedPGInteractionIntegrationData(t *testing.T, ctx context.Context, conn *pgx.Conn, now time.Time) {
	t.Helper()
	for _, user := range []struct{ id, login, kind string }{
		{"usr_interaction_owner", "interaction-owner", "human"},
		{"usr_interaction_member", "interaction-member", "human"},
		{"usr_interaction_bot", "interaction-bot", "bot"},
	} {
		mustExecPGInteraction(t, ctx, conn, `INSERT INTO users (id, github_login, display_name, kind, created_at) VALUES ($1, $2, $2, $3, $4)`, user.id, user.login, user.kind, now)
	}
	mustExecPGInteraction(t, ctx, conn, `INSERT INTO spaces (id, name, slug, created_by, created_at) VALUES ($1, 'Interactions integration', 'interactions-integration', $2, $3)`, DefaultSpaceID, "usr_interaction_owner", now)
	for _, member := range []struct{ id, role string }{{"usr_interaction_owner", "owner"}, {"usr_interaction_member", "member"}, {"usr_interaction_bot", "member"}} {
		mustExecPGInteraction(t, ctx, conn, `INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4)`, DefaultSpaceID, member.id, member.role, now)
	}
	mustExecPGInteraction(t, ctx, conn, `INSERT INTO conversations (id, space_id, type, title, retention_count, created_by, created_at) VALUES ('conv-interactions', $1, 'group', 'Interactions integration', 10000, 'usr_interaction_owner', $2)`, DefaultSpaceID, now)
	for _, userID := range []string{"usr_interaction_owner", "usr_interaction_member", "usr_interaction_bot"} {
		mustExecPGInteraction(t, ctx, conn, `INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES ('conv-interactions', $1, $2)`, userID, now)
	}
}

func mustExecPGInteraction(t *testing.T, ctx context.Context, conn *pgx.Conn, query string, args ...any) {
	t.Helper()
	if _, err := conn.Exec(ctx, query, args...); err != nil {
		t.Fatal(err)
	}
}

func pgInteractionCount(t *testing.T, fixture *pgInteractionIntegrationFixture, query string, args ...any) int64 {
	t.Helper()
	var count int64
	if err := fixture.pool.QueryRow(fixture.ctx, query, args...).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func pgInteractionNumber(value any) (int64, bool) {
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

func pgInteractionErrorCode(err error) string {
	var value *Error
	if errors.As(err, &value) {
		return value.Code
	}
	return ""
}

func TestPGInteractionLifecycleUsesIsolatedSchemaAndEvidence(t *testing.T) {
	fixture := newPGInteractionIntegrationFixture(t)
	command := ExecuteCommandInput{ActorID: "usr_interaction_owner", SpaceID: DefaultSpaceID, ConversationID: "conv-interactions", BotUserID: "usr_interaction_bot", Source: "/echo hello", MentionedBotIDs: []string{"usr_interaction_bot"}, ClientInvocationID: "command-pg-1", Request: Request{Meta: authRequestMeta("interaction-command")}}
	first, err := fixture.service.ExecuteCommand(fixture.ctx, command)
	if err != nil || !first.OK || first.Replayed {
		t.Fatalf("command = %#v, err=%v", first, err)
	}
	replayed, err := fixture.service.ExecuteCommand(fixture.ctx, command)
	if err != nil || !replayed.Replayed {
		t.Fatalf("command replay = %#v, err=%v", replayed, err)
	}
	conflict := command
	conflict.Source = "/echo changed"
	if _, err := fixture.service.ExecuteCommand(fixture.ctx, conflict); pgInteractionErrorCode(err) != CodeCommandIdempotencyConflict {
		t.Fatalf("command conflict = %v", err)
	}
	if got := pgInteractionCount(t, fixture, `SELECT COUNT(*) FROM workspace_command_runs`); got != 1 {
		t.Fatalf("command runs = %d", got)
	}
	if got := pgInteractionCount(t, fixture, `SELECT COUNT(*) FROM workspace_events WHERE type = 'command.invoked'`); got != 1 {
		t.Fatalf("command events = %d", got)
	}
	if got := pgInteractionCount(t, fixture, `SELECT COUNT(*) FROM audit_logs WHERE action = 'command.echo' AND result = 'success'`); got != 1 {
		t.Fatalf("command audits = %d", got)
	}

	start := StartWorkflowInput{ActorID: "usr_interaction_owner", SpaceID: DefaultSpaceID, ConversationID: "conv-interactions", BotUserID: "usr_interaction_bot", Type: "setup", Version: 1, ClientInvocationID: "workflow-pg-1", Request: Request{Meta: authRequestMeta("interaction-workflow")}}
	workflow, err := fixture.service.StartWorkflow(fixture.ctx, start)
	if err != nil || workflow.Status != "active" || workflow.Revision != 1 || workflow.CreatedAt != "2026-09-04T12:34:56.789Z" {
		t.Fatalf("workflow = %#v, err=%v", workflow, err)
	}
	workflowReplay, err := fixture.service.StartWorkflow(fixture.ctx, start)
	if err != nil || workflowReplay.ID != workflow.ID {
		t.Fatalf("workflow replay = %#v, err=%v", workflowReplay, err)
	}
	other := start
	other.ClientInvocationID = "workflow-pg-2"
	if _, err := fixture.service.StartWorkflow(fixture.ctx, other); pgInteractionErrorCode(err) != CodeWorkflowActiveConflict {
		t.Fatalf("workflow active conflict = %v", err)
	}
	continued, err := fixture.service.ContinueWorkflow(fixture.ctx, "usr_interaction_owner", ContinueWorkflowInput{WorkflowID: workflow.ID, ExpectedRevision: 1, Input: map[string]any{}})
	if err != nil || continued.Workflow.Status != "completed" || continued.Workflow.Revision != 2 {
		t.Fatalf("workflow continue = %#v, err=%v", continued, err)
	}
	if _, err := fixture.service.ContinueWorkflow(fixture.ctx, "usr_interaction_owner", ContinueWorkflowInput{WorkflowID: workflow.ID, ExpectedRevision: 1}); pgInteractionErrorCode(err) != CodeWorkflowNotActive {
		t.Fatalf("completed workflow = %v", err)
	}

	startCancel := start
	startCancel.ClientInvocationID = "workflow-pg-cancel"
	toCancel, err := fixture.service.StartWorkflow(fixture.ctx, startCancel)
	if err != nil {
		t.Fatal(err)
	}
	cancelled, err := fixture.service.CancelWorkflow(fixture.ctx, "usr_interaction_owner", CancelWorkflowInput{WorkflowID: toCancel.ID})
	if err != nil || cancelled.Status != "cancelled" || cancelled.Revision != 2 {
		t.Fatalf("cancelled workflow = %#v, err=%v", cancelled, err)
	}
	if got := pgInteractionCount(t, fixture, `SELECT COUNT(*) FROM workspace_events WHERE type LIKE 'workflow.%'`); got != 4 {
		t.Fatalf("workflow events = %d", got)
	}
	if got := pgInteractionCount(t, fixture, `SELECT COUNT(*) FROM audit_logs WHERE action LIKE 'workflow.%' AND result = 'success'`); got < 4 {
		t.Fatalf("workflow audits = %d", got)
	}
	var eventPayload string
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT payload_json FROM workspace_events WHERE type = 'workflow.started' ORDER BY seq DESC LIMIT 1`).Scan(&eventPayload); err != nil {
		t.Fatal(err)
	}
	if eventPayload == "" || eventPayload == "{}" || len(eventPayload) > 256 {
		t.Fatalf("workflow evidence = %s", eventPayload)
	}
	if err := fixture.service.repo.WithTx(fixture.ctx, func(tx Tx) error {
		return tx.CompleteCommandRun(fixture.ctx, "missing-run", nil, []byte(`{}`), fixture.now)
	}); err == nil {
		t.Fatal("missing command run completed")
	}
	if err := fixture.service.repo.WithTx(fixture.ctx, func(tx Tx) error {
		return tx.FailCommandRun(fixture.ctx, "missing-run", "command.test_failure", fixture.now)
	}); err == nil {
		t.Fatal("missing command run failed")
	}
	if _, err := fixture.pool.Exec(fixture.ctx, `UPDATE space_members SET removed_at = $1 WHERE space_id = $2 AND user_id = 'usr_interaction_bot'`, fixture.now, DefaultSpaceID); err != nil {
		t.Fatal(err)
	}
	revokedBot := command
	revokedBot.ClientInvocationID = "command-pg-revoked-bot"
	if _, err := fixture.service.ExecuteCommand(fixture.ctx, revokedBot); pgInteractionErrorCode(err) != CodeBotNotAvailable {
		t.Fatalf("revoked bot command = %v", err)
	}
}

func authRequestMeta(requestID string) auth.RequestMeta {
	return auth.RequestMeta{RequestID: requestID, IPAddress: "198.51.100.9", UserAgent: "interactions-integration"}
}
