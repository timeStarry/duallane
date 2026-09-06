//go:build postgres_integration

package automation

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
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/releases"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/solicitations"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/interactions"
)

type pgAutomationIntegrationFixture struct {
	ctx            context.Context
	pool           *pgxpool.Pool
	repo           *PGRepository
	service        *interactions.Service
	spaceID        string
	memberID       string
	conversationID string
	echoUserID     string
	now            time.Time
}

func newPGEchoAutomationIntegrationFixture(t *testing.T) *pgAutomationIntegrationFixture {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	t.Cleanup(cancel)
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })

	schema := fmt.Sprintf("duallane_echo_automation_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
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
	migrationDirectory := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../../web/server/migrations"))
	if _, err := (platformmigrations.Runner{Beginner: platformpostgres.NewMigrationBeginner(conn), Directory: migrationDirectory}).Run(ctx); err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 9, 6, 12, 34, 56, 789654321, time.UTC)
	seedPGEchoAutomationData(t, ctx, conn, now)
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

	var sequence atomic.Int64
	idFactory := func() (string, error) {
		return fmt.Sprintf("echo-automation-integration-%03d", sequence.Add(1)), nil
	}
	interactionRepository := interactions.NewPGRepository(pool, idFactory)
	requirementRepository := requirements.NewPGRepository(pool, idFactory)
	solicitationRepository := solicitations.NewPGRepository(pool, idFactory)
	repository := NewPGRepository(pool, PGRepositoryOptions{
		InteractionRepository:   interactionRepository,
		RequirementsRepository:  requirementRepository,
		SolicitationsRepository: solicitationRepository,
		ReleasesRepository:      releasesRepositoryForAutomation(pool, idFactory),
	})

	requirementService := requirements.NewService(requirements.ServiceOptions{
		Repository: requirementRepository,
		SpaceID:    auth.DefaultSpaceID,
		Now:        func() time.Time { return now },
		IDFactory:  idFactory,
	})
	solicitationService := solicitations.NewService(solicitations.ServiceOptions{
		Repository: solicitationRepository,
		SpaceID:    auth.DefaultSpaceID,
		Now:        func() time.Time { return now },
		IDFactory:  idFactory,
	})
	registries, err := NewRegistries(Options{Requirements: requirementService, Solicitations: solicitationService})
	if err != nil {
		t.Fatal(err)
	}
	service := interactions.NewService(interactions.ServiceOptions{
		Repository:       repository,
		CommandRegistry:  registries.Commands,
		WorkflowRegistry: registries.Workflows,
		SpaceID:          auth.DefaultSpaceID,
		Now:              func() time.Time { return now },
		IDFactory:        idFactory,
	})
	return &pgAutomationIntegrationFixture{
		ctx: ctx, pool: pool, repo: repository, service: service,
		spaceID: auth.DefaultSpaceID, memberID: "usr_echo_automation_member",
		conversationID: "conv-echo-automation", echoUserID: EchoBotUserID, now: now,
	}
}

// The release service requires a non-empty catalog; this test does not invoke
// /release, but the shared repository still exposes its configured typed view
// so construction validates all four domain factories.
func releasesRepositoryForAutomation(pool *pgxpool.Pool, factory func() (string, error)) ReleasesTransactionRepository {
	return releases.NewPGRepository(pool, factory)
}

func seedPGEchoAutomationData(t *testing.T, ctx context.Context, conn *pgx.Conn, now time.Time) {
	t.Helper()
	for _, user := range []struct {
		id, login, email, displayName, kind string
	}{
		{"usr_echo_automation_owner", "echo-automation-owner", "echo-automation-owner@example.com", "Echo automation owner", "human"},
		{"usr_echo_automation_member", "echo-automation-member", "echo-automation-member@example.com", "Echo automation member", "human"},
		{EchoBotUserID, "__duallane_echo__", "", "Echo", "bot"},
	} {
		mustExecPGEchoAutomation(t, ctx, conn, `INSERT INTO users (id, github_id, github_login, email, display_name, avatar_url, kind, created_at) VALUES ($1, $2, $3, NULLIF($4, ''), $5, NULL, $6, $7)`, user.id, user.id+"-github", user.login, user.email, user.displayName, user.kind, now)
	}
	mustExecPGEchoAutomation(t, ctx, conn, `INSERT INTO spaces (id, name, slug, created_by, created_at) VALUES ($1, 'Echo automation integration', 'echo-automation-integration', $2, $3)`, auth.DefaultSpaceID, "usr_echo_automation_owner", now)
	for _, member := range []struct{ id, role string }{
		{"usr_echo_automation_owner", "owner"},
		{"usr_echo_automation_member", "member"},
		{EchoBotUserID, "member"},
	} {
		mustExecPGEchoAutomation(t, ctx, conn, `INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4)`, auth.DefaultSpaceID, member.id, member.role, now)
	}
	mustExecPGEchoAutomation(t, ctx, conn, `INSERT INTO conversations (id, space_id, type, title, direct_key, retention_count, created_by, created_at) VALUES ($1, $2, 'group', 'Echo automation', NULL, 10000, $3, $4)`, "conv-echo-automation", auth.DefaultSpaceID, "usr_echo_automation_owner", now)
	for _, userID := range []string{"usr_echo_automation_owner", "usr_echo_automation_member", EchoBotUserID} {
		mustExecPGEchoAutomation(t, ctx, conn, `INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES ($1, $2, $3)`, "conv-echo-automation", userID, now)
	}
}

func mustExecPGEchoAutomation(t *testing.T, ctx context.Context, conn *pgx.Conn, query string, args ...any) {
	t.Helper()
	if _, err := conn.Exec(ctx, query, args...); err != nil {
		t.Fatal(err)
	}
}

func pgAutomationCount(t *testing.T, fixture *pgAutomationIntegrationFixture, query string, args ...any) int64 {
	t.Helper()
	var count int64
	if err := fixture.pool.QueryRow(fixture.ctx, query, args...).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestPGEchoAutomationCommandReplayWorkflowCommitAndDomainRollback(t *testing.T) {
	fixture := newPGEchoAutomationIntegrationFixture(t)
	command := interactions.ExecuteCommandInput{
		ActorID: fixture.memberID, SpaceID: fixture.spaceID, ConversationID: fixture.conversationID,
		BotUserID: fixture.echoUserID, Source: "/need", MentionedBotIDs: []string{fixture.echoUserID},
		ClientInvocationID: "echo-automation-command-1", Request: interactions.Request{Meta: auth.RequestMeta{RequestID: "echo-automation-command"}},
	}
	first, err := fixture.service.ExecuteCommand(fixture.ctx, command)
	if err != nil || !first.OK || first.Replayed {
		t.Fatalf("first command = %#v, err=%v", first, err)
	}
	replayed, err := fixture.service.ExecuteCommand(fixture.ctx, command)
	if err != nil || !replayed.OK || !replayed.Replayed {
		t.Fatalf("replayed command = %#v, err=%v", replayed, err)
	}
	if got := pgAutomationCount(t, fixture, `SELECT COUNT(*) FROM workspace_command_runs WHERE client_invocation_id = 'echo-automation-command-1'`); got != 1 {
		t.Fatalf("command run count = %d", got)
	}

	startInput := interactions.StartWorkflowInput{
		ActorID: fixture.memberID, SpaceID: fixture.spaceID, ConversationID: fixture.conversationID,
		BotUserID: fixture.echoUserID, Type: RequirementWorkflowType, Version: WorkflowVersion,
		Input: map[string]any{
			"type": "requirement", "title": "Transactional requirement", "detail": "synthetic detail",
			"scenario": "synthetic scenario", "expectedResult": "synthetic result",
		}, ClientInvocationID: "echo-automation-workflow-1",
		Request: interactions.Request{Meta: auth.RequestMeta{RequestID: "echo-automation-workflow"}},
	}
	workflow, err := fixture.service.StartWorkflow(fixture.ctx, startInput)
	if err != nil || workflow.Status != "active" || workflow.Revision != 1 {
		t.Fatalf("started workflow = %#v, err=%v", workflow, err)
	}
	workflowReplay, err := fixture.service.StartWorkflow(fixture.ctx, startInput)
	if err != nil || workflowReplay.ID != workflow.ID {
		t.Fatalf("replayed workflow = %#v, err=%v", workflowReplay, err)
	}
	continued, err := fixture.service.ContinueWorkflow(fixture.ctx, fixture.memberID, interactions.ContinueWorkflowInput{
		WorkflowID: workflow.ID, ExpectedRevision: 1,
		Input:   map[string]any{"confirm": true, "idempotencyKey": "echo-automation-submit-1"},
		Request: interactions.Request{Meta: auth.RequestMeta{RequestID: "echo-automation-submit"}},
	})
	if err != nil || continued.Workflow.Status != "completed" || continued.Workflow.Revision != 2 {
		t.Fatalf("continued workflow = %#v, err=%v", continued, err)
	}
	if got := pgAutomationCount(t, fixture, `SELECT COUNT(*) FROM echo_requirements`); got != 1 {
		t.Fatalf("requirements after successful workflow = %d", got)
	}
	if got := pgAutomationCount(t, fixture, `SELECT COUNT(*) FROM workspace_events WHERE type = 'echo.requirement.submitted'`); got != 1 {
		t.Fatalf("requirement events = %d", got)
	}

	rejectStart := startInput
	rejectStart.ClientInvocationID = "echo-automation-workflow-reject"
	rejectStart.Input = map[string]any{
		"type": "requirement", "title": "Rejected requirement", "detail": "synthetic detail",
		"scenario": "synthetic scenario", "expectedResult": "synthetic result",
	}
	rejectWorkflow, err := fixture.service.StartWorkflow(fixture.ctx, rejectStart)
	if err != nil {
		t.Fatalf("start rejection workflow: %v", err)
	}
	if _, err := fixture.service.ContinueWorkflow(fixture.ctx, fixture.memberID, interactions.ContinueWorkflowInput{
		WorkflowID: rejectWorkflow.ID, ExpectedRevision: 1,
		Input:   map[string]any{"confirm": true, "type": "invalid-type", "idempotencyKey": "echo-automation-submit-reject"},
		Request: interactions.Request{Meta: auth.RequestMeta{RequestID: "echo-automation-submit-reject"}},
	}); err == nil {
		t.Fatal("invalid requirement unexpectedly succeeded")
	}
	if got := pgAutomationCount(t, fixture, `SELECT COUNT(*) FROM echo_requirements`); got != 1 {
		t.Fatalf("requirements after rejected workflow = %d", got)
	}
	if got := pgAutomationCount(t, fixture, `SELECT COUNT(*) FROM audit_logs WHERE action = 'echo.requirement.submit' AND result = 'rejected'`); got != 1 {
		t.Fatalf("content-free requirement rejection audits = %d", got)
	}
	var status string
	var revision int64
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT status, revision FROM workspace_workflow_sessions WHERE id = $1`, rejectWorkflow.ID).Scan(&status, &revision); err != nil {
		t.Fatal(err)
	}
	if status != "active" || revision != 1 {
		t.Fatalf("rejected workflow state = %s/%d", status, revision)
	}
}

func TestPGEchoAutomationSavepointRollsBackTypedDomainWrite(t *testing.T) {
	fixture := newPGEchoAutomationIntegrationFixture(t)
	requirementRepository := requirements.NewPGRepository(fixture.pool, func() (string, error) { return "echo-automation-savepoint-id", nil })
	requirementService := requirements.NewService(requirements.ServiceOptions{
		Repository: requirementRepository, SpaceID: fixture.spaceID,
		Now:       func() time.Time { return fixture.now },
		IDFactory: func() (string, error) { return "echo-automation-savepoint-id", nil },
	})
	callbackErr := errors.New("synthetic post-domain failure")
	err := fixture.repo.WithTx(fixture.ctx, func(tx interactions.Tx) error {
		provider, ok := tx.(SharedTxProvider)
		if !ok {
			return errors.New("shared provider missing")
		}
		return provider.WithEchoSavepoint(fixture.ctx, "automation_rollback", func(actionCtx context.Context) error {
			_, err := requirementService.SubmitInTx(actionCtx, provider.RequirementTransaction(), requirements.SubmitInput{
				ActorID: fixture.memberID, SpaceID: fixture.spaceID, Type: requirements.TypeRequirement,
				Title: "Rolled back requirement", Detail: "synthetic detail", Scenario: "synthetic scenario",
				ExpectedResult: "synthetic result", IdempotencyKey: "echo-automation-savepoint-submit",
			})
			if err != nil {
				return err
			}
			return callbackErr
		})
	})
	if !errors.Is(err, callbackErr) {
		t.Fatalf("savepoint error = %v", err)
	}
	if got := pgAutomationCount(t, fixture, `SELECT COUNT(*) FROM echo_requirements`); got != 0 {
		t.Fatalf("rolled-back requirements = %d", got)
	}
}

func TestPGEchoAutomationSolicitationWorkflowSharesTxAndRollsBackDraftOnPublishRejection(t *testing.T) {
	fixture := newPGEchoAutomationIntegrationFixture(t)
	start := interactions.StartWorkflowInput{
		ActorID: "usr_echo_automation_owner", SpaceID: fixture.spaceID, ConversationID: fixture.conversationID,
		BotUserID: fixture.echoUserID, Type: PublishWorkflowType, Version: WorkflowVersion,
		Input:              map[string]any{"title": "Transactional solicitation", "description": "synthetic description", "question": "synthetic question", "options": []any{"A", "B"}},
		ClientInvocationID: "echo-automation-publish-1",
		Request:            interactions.Request{Meta: auth.RequestMeta{RequestID: "echo-automation-publish"}},
	}
	workflow, err := fixture.service.StartWorkflow(fixture.ctx, start)
	if err != nil {
		t.Fatalf("start publish workflow: %v", err)
	}
	continued, err := fixture.service.ContinueWorkflow(fixture.ctx, "usr_echo_automation_owner", interactions.ContinueWorkflowInput{
		WorkflowID: workflow.ID, ExpectedRevision: 1,
		Input:   map[string]any{"confirm": true, "idempotencyKey": "echo-automation-publish-key"},
		Request: interactions.Request{Meta: auth.RequestMeta{RequestID: "echo-automation-publish-submit"}},
	})
	if err != nil || continued.Workflow.Status != "completed" {
		t.Fatalf("publish workflow = %#v, err=%v", continued, err)
	}
	if got := pgAutomationCount(t, fixture, `SELECT COUNT(*) FROM echo_solicitations WHERE status = 'open'`); got != 1 {
		t.Fatalf("open solicitations = %d", got)
	}

	reject := start
	reject.ClientInvocationID = "echo-automation-publish-reject"
	reject.Input = map[string]any{
		"title": "Rejected solicitation", "description": "synthetic description", "question": "synthetic question",
		"options": []any{"A", "B"}, "deadline": fixture.now.Add(-time.Hour).Format(time.RFC3339),
	}
	rejectWorkflow, err := fixture.service.StartWorkflow(fixture.ctx, reject)
	if err != nil {
		t.Fatalf("start rejected publish workflow: %v", err)
	}
	if _, err := fixture.service.ContinueWorkflow(fixture.ctx, "usr_echo_automation_owner", interactions.ContinueWorkflowInput{
		WorkflowID: rejectWorkflow.ID, ExpectedRevision: 1,
		Input:   map[string]any{"confirm": true, "idempotencyKey": "echo-automation-publish-reject-key"},
		Request: interactions.Request{Meta: auth.RequestMeta{RequestID: "echo-automation-publish-reject"}},
	}); err == nil {
		t.Fatal("expired solicitation unexpectedly published")
	}
	if got := pgAutomationCount(t, fixture, `SELECT COUNT(*) FROM echo_solicitations`); got != 1 {
		t.Fatalf("solicitations after rejected publish = %d", got)
	}
	if got := pgAutomationCount(t, fixture, `SELECT COUNT(*) FROM audit_logs WHERE action = 'echo.solicitation.publish' AND result = 'rejected'`); got != 1 {
		t.Fatalf("content-free solicitation rejection audits = %d", got)
	}
}
