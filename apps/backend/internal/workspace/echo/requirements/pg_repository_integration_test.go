//go:build postgres_integration

package requirements

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	platformmigrations "github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type pgRequirementIntegrationFixture struct {
	ctx     context.Context
	pool    *pgxpool.Pool
	service *Service
	now     time.Time
}

func newPGRequirementIntegrationFixture(t *testing.T) *pgRequirementIntegrationFixture {
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

	schema := fmt.Sprintf("duallane_echo_requirements_%d", time.Now().UnixNano())
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
	migrationDirectory := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../../web/server/migrations"))
	if _, err := (platformmigrations.Runner{Beginner: platformpostgres.NewMigrationBeginner(conn), Directory: migrationDirectory}).Run(ctx); err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 9, 6, 12, 34, 56, 789654321, time.UTC)
	seedPGRequirementIntegrationData(t, ctx, conn, now)
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
		return fmt.Sprintf("echo-integration-%03d", sequence.Add(1)), nil
	}
	repository := NewPGRepository(pool, idFactory)
	return &pgRequirementIntegrationFixture{
		ctx: ctx, pool: pool, now: now,
		service: NewService(ServiceOptions{Repository: repository, SpaceID: DefaultSpaceID, Now: func() time.Time { return now }, IDFactory: idFactory}),
	}
}

func seedPGRequirementIntegrationData(t *testing.T, ctx context.Context, conn *pgx.Conn, now time.Time) {
	t.Helper()
	for _, user := range []struct {
		id, login, kind string
	}{
		{"usr_echo_pg_owner", "echo-pg-owner", "human"},
		{"usr_echo_pg_member", "echo-pg-member", "human"},
		{"usr_echo_pg_other", "echo-pg-other", "human"},
		{"usr_echo_pg_auditor", "echo-pg-auditor", "human"},
	} {
		mustExecPGRequirement(t, ctx, conn, `INSERT INTO users (id, github_login, display_name, kind, created_at) VALUES ($1, $2, $2, $3, $4)`, user.id, user.login, user.kind, now)
	}
	mustExecPGRequirement(t, ctx, conn, `INSERT INTO spaces (id, name, slug, created_by, created_at) VALUES ($1, 'Echo requirements integration', 'echo-requirements-integration', $2, $3)`, DefaultSpaceID, "usr_echo_pg_owner", now)
	for _, member := range []struct {
		id, role string
	}{
		{"usr_echo_pg_owner", "owner"},
		{"usr_echo_pg_member", "member"},
		{"usr_echo_pg_other", "member"},
		{"usr_echo_pg_auditor", "auditor"},
	} {
		mustExecPGRequirement(t, ctx, conn, `INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4)`, DefaultSpaceID, member.id, member.role, now)
	}
}

func mustExecPGRequirement(t *testing.T, ctx context.Context, conn *pgx.Conn, query string, args ...any) {
	t.Helper()
	if _, err := conn.Exec(ctx, query, args...); err != nil {
		t.Fatal(err)
	}
}

func pgRequirementCount(t *testing.T, fixture *pgRequirementIntegrationFixture, query string, args ...any) int64 {
	t.Helper()
	var count int64
	if err := fixture.pool.QueryRow(fixture.ctx, query, args...).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func pgRequirementHasCode(err error, code string) bool {
	var domainErr *Error
	return errors.As(err, &domainErr) && domainErr != nil && domainErr.Code == code
}

func pgRequirementSubmitInput(actorID, key string) SubmitInput {
	return SubmitInput{
		ActorID: actorID, Type: TypeRequirement, Title: "PG integration requirement",
		Detail: "synthetic private detail", Scenario: "synthetic integration scenario",
		ExpectedResult: "synthetic expected result", RelatedLink: "https://example.com/echo",
		IdempotencyKey: key, Meta: auth.RequestMeta{RequestID: "echo-pg-request", IPAddress: "203.0.113.9", UserAgent: "echo-pg-test"},
	}
}

func TestPGRequirementLifecyclePrivacyAndCards(t *testing.T) {
	fixture := newPGRequirementIntegrationFixture(t)
	created, err := fixture.service.Submit(fixture.ctx, pgRequirementSubmitInput("usr_echo_pg_member", "submit-pg-1"))
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	if created.PublicID != "REQ-2026-0001" || created.State != StateSubmitted || created.Phase != PhaseProposal || created.Status != StatusPendingReview {
		t.Fatalf("unexpected created projection: %+v", created)
	}

	replayed, err := fixture.service.Submit(fixture.ctx, pgRequirementSubmitInput("usr_echo_pg_member", "submit-pg-1"))
	if err != nil {
		t.Fatalf("submit replay: %v", err)
	}
	if !reflect.DeepEqual(replayed, created) {
		t.Fatalf("replay changed result: got %+v want %+v", replayed, created)
	}
	if got := pgRequirementCount(t, fixture, `SELECT COUNT(*) FROM audit_logs WHERE action = 'echo.requirement.submit'`); got != 1 {
		t.Fatalf("submit audit count = %d, want 1", got)
	}

	memberView, err := fixture.service.Get(fixture.ctx, GetInput{ActorID: "usr_echo_pg_member", PublicID: created.PublicID})
	if err != nil || memberView.Detail != "synthetic private detail" {
		t.Fatalf("member view: %+v err=%v", memberView, err)
	}
	if _, err := fixture.service.Get(fixture.ctx, GetInput{ActorID: "usr_echo_pg_other", PublicID: created.PublicID}); !pgRequirementHasCode(err, CodeRequirementNotFound) {
		t.Fatalf("unauthorized get: %v", err)
	}
	if got := pgRequirementCount(t, fixture, `SELECT COUNT(*) FROM audit_logs WHERE action = 'echo.requirement.read' AND result = 'rejected'`); got != 1 {
		t.Fatalf("read rejection audit count = %d, want 1", got)
	}

	memberList, err := fixture.service.ListPage(fixture.ctx, ListInput{ActorID: "usr_echo_pg_member", Limit: 10})
	if err != nil || memberList.Total != 1 || len(memberList.Items) != 1 {
		t.Fatalf("member list: %+v err=%v", memberList, err)
	}
	ownerList, err := fixture.service.ListPage(fixture.ctx, ListInput{ActorID: "usr_echo_pg_owner", Limit: 10})
	if err != nil || ownerList.Total != 1 || len(ownerList.Items) != 1 {
		t.Fatalf("owner list: %+v err=%v", ownerList, err)
	}
	otherList, err := fixture.service.ListPage(fixture.ctx, ListInput{ActorID: "usr_echo_pg_other", Limit: 10})
	if err != nil || otherList.Total != 0 || len(otherList.Items) != 0 {
		t.Fatalf("other list: %+v err=%v", otherList, err)
	}
	stats, err := fixture.service.Stats(fixture.ctx, StatsInput{ActorID: "usr_echo_pg_owner"})
	if err != nil || stats.Total != 1 || stats.ByPhase[PhaseProposal] != 1 || stats.ByStatus[StatusPendingReview] != 1 {
		t.Fatalf("owner stats: %+v err=%v", stats, err)
	}
	history, err := fixture.service.History(fixture.ctx, HistoryInput{ActorID: "usr_echo_pg_member", PublicID: created.PublicID})
	if err != nil || len(history) != 1 || history[0].IdempotencyKey != nil {
		t.Fatalf("history projection: %+v err=%v", history, err)
	}

	event, err := fixture.service.ProjectEvent(fixture.ctx, GetInput{ActorID: "usr_echo_pg_member", PublicID: created.PublicID})
	if err != nil || event == nil || event.Payload.Card.CardType != CardTypeRequirementStatus {
		t.Fatalf("event projection: %+v err=%v", event, err)
	}
	card, err := fixture.service.ProjectCard(fixture.ctx, GetInput{ActorID: "usr_echo_pg_member", PublicID: created.PublicID})
	if err != nil || card.Block.CardType != CardTypeRequirement || card.Payload["detail"] != "synthetic private detail" {
		t.Fatalf("request card: %+v err=%v", card, err)
	}
	statusCard, err := fixture.service.ProjectCard(fixture.ctx, GetInput{ActorID: "usr_echo_pg_member", PublicID: created.PublicID, CardType: CardTypeRequirementStatus})
	if err != nil || statusCard.Block.CardType != CardTypeRequirementStatus {
		t.Fatalf("status card: %+v err=%v", statusCard, err)
	}
	if _, err := fixture.service.ProjectCard(fixture.ctx, GetInput{ActorID: "usr_echo_pg_member", PublicID: created.PublicID, CardType: "echo.unknown"}); !pgRequirementHasCode(err, CodeCardTypeInvalid) {
		t.Fatalf("invalid card type: %v", err)
	}

	var eventType, payloadJSON string
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT type, payload_json FROM workspace_events WHERE space_id = $1 ORDER BY seq`, DefaultSpaceID).Scan(&eventType, &payloadJSON); err != nil {
		t.Fatal(err)
	}
	if eventType != "echo.requirement.submitted" {
		t.Fatalf("event type = %q, want echo.requirement.submitted", eventType)
	}
	var eventPayload map[string]any
	if err := json.Unmarshal([]byte(payloadJSON), &eventPayload); err != nil {
		t.Fatal(err)
	}
	if _, exists := eventPayload["detail"]; exists {
		t.Fatal("event payload contains private detail")
	}
}

func TestPGRequirementTransitionAuditRevisionAndHistory(t *testing.T) {
	fixture := newPGRequirementIntegrationFixture(t)
	created, err := fixture.service.Submit(fixture.ctx, pgRequirementSubmitInput("usr_echo_pg_member", "submit-pg-transition"))
	if err != nil {
		t.Fatalf("submit: %v", err)
	}

	collected, err := fixture.service.Transition(fixture.ctx, TransitionInput{ActorID: "usr_echo_pg_owner", PublicID: created.PublicID, ToState: StateCollected, ExpectedRevision: 1, IdempotencyKey: "collect-pg"})
	if err != nil || collected.State != StateCollected || collected.Phase != PhaseFormal || collected.Status != StatusPlanned || collected.Revision != 2 {
		t.Fatalf("collect: %+v err=%v", collected, err)
	}
	replayed, err := fixture.service.Transition(fixture.ctx, TransitionInput{ActorID: "usr_echo_pg_owner", PublicID: created.PublicID, ToState: StateCollected, ExpectedRevision: 1, IdempotencyKey: "collect-pg"})
	if err != nil || !reflect.DeepEqual(replayed, collected) {
		t.Fatalf("transition replay: %+v err=%v", replayed, err)
	}
	if got := pgRequirementCount(t, fixture, `SELECT COUNT(*) FROM audit_logs WHERE action = 'echo.requirement.transition' AND result = 'success'`); got != 1 {
		t.Fatalf("transition success audit count = %d, want 1", got)
	}

	if _, err := fixture.service.Transition(fixture.ctx, TransitionInput{ActorID: "usr_echo_pg_member", PublicID: created.PublicID, ToState: StateInProgress, ExpectedRevision: 2, IdempotencyKey: "member-transition-pg"}); !pgRequirementHasCode(err, CodeRequirementNotFound) {
		t.Fatalf("member transition: %v", err)
	}
	if _, err := fixture.service.Transition(fixture.ctx, TransitionInput{ActorID: "usr_echo_pg_owner", PublicID: created.PublicID, ToState: StateImplemented, ExpectedRevision: 1, IdempotencyKey: "stale-pg"}); !pgRequirementHasCode(err, CodeRevisionConflict) {
		t.Fatalf("stale transition: %v", err)
	}
	if _, err := fixture.service.Transition(fixture.ctx, TransitionInput{ActorID: "usr_echo_pg_owner", PublicID: created.PublicID, ToState: StateRejected, ExpectedRevision: 2, IdempotencyKey: "reject-missing-pg"}); !pgRequirementHasCode(err, CodeRejectionResponseRequired) {
		t.Fatalf("missing rejection response: %v", err)
	}
	rejected, err := fixture.service.Transition(fixture.ctx, TransitionInput{ActorID: "usr_echo_pg_owner", PublicID: created.PublicID, ToState: StateRejected, Response: "synthetic rejection response", ExpectedRevision: 2, IdempotencyKey: "reject-pg"})
	if err != nil || rejected.State != StateRejected || rejected.Phase != PhaseArchived || rejected.Status != StatusArchived || rejected.ArchiveOutcome == nil || *rejected.ArchiveOutcome != ArchiveRejected || rejected.Revision != 3 {
		t.Fatalf("reject: %+v err=%v", rejected, err)
	}
	if _, err := fixture.service.Transition(fixture.ctx, TransitionInput{ActorID: "usr_echo_pg_owner", PublicID: created.PublicID, ToState: StateCollected, ExpectedRevision: 3, IdempotencyKey: "terminal-pg"}); !pgRequirementHasCode(err, CodeInvalidTransition) {
		t.Fatalf("terminal transition: %v", err)
	}

	history, err := fixture.service.History(fixture.ctx, HistoryInput{ActorID: "usr_echo_pg_owner", PublicID: created.PublicID})
	if err != nil || len(history) != 3 || history[2].Response == nil || history[2].IdempotencyKey != nil {
		t.Fatalf("transition history: %+v err=%v", history, err)
	}
	if got := pgRequirementCount(t, fixture, `SELECT COUNT(*) FROM workspace_events WHERE space_id = $1`, DefaultSpaceID); got != 3 {
		t.Fatalf("event count = %d, want 3", got)
	}
	rows, err := fixture.pool.Query(fixture.ctx, `SELECT seq, payload_json FROM workspace_events WHERE space_id = $1 ORDER BY seq`, DefaultSpaceID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var expectedSeq int64 = 1
	for rows.Next() {
		var seq int64
		var payloadJSON string
		if err := rows.Scan(&seq, &payloadJSON); err != nil {
			t.Fatal(err)
		}
		if seq != expectedSeq {
			t.Fatalf("event seq = %d, want %d", seq, expectedSeq)
		}
		expectedSeq++
		var payload map[string]any
		if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
			t.Fatal(err)
		}
		if _, exists := payload["detail"]; exists {
			t.Fatal("transition event contains private detail")
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if got := pgRequirementCount(t, fixture, `SELECT COUNT(*) FROM audit_logs WHERE action = 'echo.requirement.transition' AND result = 'rejected'`); got != 4 {
		t.Fatalf("transition rejection audit count = %d, want 4", got)
	}
}

func TestPGRequirementConcurrentSequenceAllocation(t *testing.T) {
	fixture := newPGRequirementIntegrationFixture(t)
	const count = 8
	results := make(chan *Requirement, count)
	errs := make(chan error, count)
	var wait sync.WaitGroup
	for i := 0; i < count; i++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			result, err := fixture.service.Submit(fixture.ctx, pgRequirementSubmitInput("usr_echo_pg_member", fmt.Sprintf("parallel-pg-%d", index)))
			results <- result
			errs <- err
		}(i)
	}
	wait.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	seen := map[string]bool{}
	for result := range results {
		if result == nil || seen[result.PublicID] {
			t.Fatalf("duplicate or missing public id: %+v", result)
		}
		seen[result.PublicID] = true
	}
	if len(seen) != count {
		t.Fatalf("got %d public ids, want %d", len(seen), count)
	}
	if got := pgRequirementCount(t, fixture, `SELECT COUNT(*) FROM echo_requirements WHERE space_id = $1`, DefaultSpaceID); got != count {
		t.Fatalf("requirement count = %d, want %d", got, count)
	}
}
