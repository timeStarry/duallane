//go:build postgres_integration

package solicitations

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

type pgSolicitationIntegrationFixture struct {
	ctx            context.Context
	pool           *pgxpool.Pool
	service        *Service
	now            *time.Time
	spaceID        string
	conversationID string
}

func newPGSolicitationIntegrationFixture(t *testing.T) *pgSolicitationIntegrationFixture {
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

	schema := fmt.Sprintf("duallane_echo_solicitations_%d", time.Now().UnixNano())
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

	current := time.Date(2026, 9, 6, 12, 34, 56, 789654321, time.UTC)
	seedPGSolicitationIntegrationData(t, ctx, conn, current)
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
		return fmt.Sprintf("echo-sol-integration-%03d", sequence.Add(1)), nil
	}
	clock := &current
	service := NewService(ServiceOptions{
		Repository: NewPGRepository(pool, idFactory), SpaceID: DefaultSpaceID,
		Now: func() time.Time { return *clock }, IDFactory: idFactory,
		ConversationAccess: pgConversationAccess{pool: pool},
	})
	return &pgSolicitationIntegrationFixture{ctx: ctx, pool: pool, service: service, now: clock, spaceID: DefaultSpaceID, conversationID: "conv-echo-member"}
}

func seedPGSolicitationIntegrationData(t *testing.T, ctx context.Context, conn *pgx.Conn, now time.Time) {
	t.Helper()
	for _, user := range []struct{ id, login, kind string }{
		{"usr_sol_pg_owner", "sol-pg-owner", "human"},
		{"usr_sol_pg_member", "sol-pg-member", "human"},
		{"usr_sol_pg_other", "sol-pg-other", "human"},
		{"usr_sol_pg_auditor", "sol-pg-auditor", "human"},
	} {
		mustExecPGSolicitation(t, ctx, conn, `INSERT INTO users (id, github_id, github_login, email, display_name, avatar_url, kind, created_at) VALUES ($1, $2, $2, $3, $2, NULL, $4, $5)`, user.id, user.id+"-github", user.id+"@example.com", user.kind, now)
	}
	mustExecPGSolicitation(t, ctx, conn, `INSERT INTO spaces (id, name, slug, created_by, created_at) VALUES ($1, 'Echo solicitations integration', 'echo-solicitations-integration', $2, $3)`, DefaultSpaceID, "usr_sol_pg_owner", now)
	for _, member := range []struct{ id, role string }{
		{"usr_sol_pg_owner", "owner"}, {"usr_sol_pg_member", "member"}, {"usr_sol_pg_other", "member"}, {"usr_sol_pg_auditor", "auditor"},
	} {
		mustExecPGSolicitation(t, ctx, conn, `INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4)`, DefaultSpaceID, member.id, member.role, now)
	}
	mustExecPGSolicitation(t, ctx, conn, `INSERT INTO conversations (id, space_id, type, title, direct_key, retention_count, created_by, created_at) VALUES ('conv-echo-member', $1, 'direct', 'Echo', 'echo-member', 10000, $2, $3)`, DefaultSpaceID, "usr_sol_pg_owner", now)
	for _, userID := range []string{"usr_sol_pg_owner", "usr_sol_pg_member"} {
		mustExecPGSolicitation(t, ctx, conn, `INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES ('conv-echo-member', $1, $2)`, userID, now)
	}
}

type pgConversationAccess struct{ pool *pgxpool.Pool }

func (a pgConversationAccess) ConversationMemberActive(ctx context.Context, spaceID, conversationID, userID string) (bool, error) {
	var active bool
	err := a.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM conversation_members cm INNER JOIN conversations c ON c.id = cm.conversation_id AND c.space_id = $1 WHERE cm.conversation_id = $2 AND cm.user_id = $3 AND cm.removed_at IS NULL)`, spaceID, conversationID, userID).Scan(&active)
	return active, err
}

func mustExecPGSolicitation(t *testing.T, ctx context.Context, conn *pgx.Conn, query string, args ...any) {
	t.Helper()
	if _, err := conn.Exec(ctx, query, args...); err != nil {
		t.Fatal(err)
	}
}

func pgSolicitationCount(t *testing.T, fixture *pgSolicitationIntegrationFixture, query string, args ...any) int64 {
	t.Helper()
	var count int64
	if err := fixture.pool.QueryRow(fixture.ctx, query, args...).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func pgSolicitationCode(err error) string {
	var domainErr *Error
	if errors.As(err, &domainErr) && domainErr != nil {
		return domainErr.Code
	}
	return ""
}

func pgSolicitationCreateInput(key string) CreateInput {
	return CreateInput{
		ActorID: "usr_sol_pg_owner", Title: "PG solicitation", Description: "synthetic description",
		Question: "synthetic question", Options: []string{"Web", "Mobile"},
		IdempotencyKey: key, Meta: auth.RequestMeta{RequestID: "sol-pg-request", IPAddress: "203.0.113.9", UserAgent: "sol-pg-test"},
	}
}

func TestPGSolicitationLifecycleAuthorizationAuditEventsAndReplay(t *testing.T) {
	fixture := newPGSolicitationIntegrationFixture(t)
	created, err := fixture.service.Create(fixture.ctx, pgSolicitationCreateInput("sol-create-1"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.PublicID != "SOL-2026-0001" || created.Status != StatusDraft || created.Revision != 1 {
		t.Fatalf("created projection = %+v", created)
	}
	replayed, err := fixture.service.Create(fixture.ctx, pgSolicitationCreateInput("sol-create-1"))
	if err != nil || !reflect.DeepEqual(replayed, created) {
		t.Fatalf("create replay = %+v err=%v want %+v", replayed, err, created)
	}
	if code := pgSolicitationCode(func() error {
		_, err := fixture.service.Get(fixture.ctx, GetInput{ActorID: "usr_sol_pg_member", PublicID: created.PublicID})
		return err
	}()); code != CodeSolicitationNotFound {
		t.Fatalf("draft member get code = %q", code)
	}

	open, err := fixture.service.Publish(fixture.ctx, TransitionInput{ActorID: "usr_sol_pg_owner", PublicID: created.PublicID, ExpectedRevision: 1, IdempotencyKey: "sol-publish-1"})
	if err != nil || open.Status != StatusOpen || open.Revision != 2 || open.OwnerProjection == nil || open.OwnerProjection.DeliverySummary[DeliveryPending] != 4 {
		t.Fatalf("publish = %+v err=%v", open, err)
	}
	memberView, err := fixture.service.Get(fixture.ctx, GetInput{ActorID: "usr_sol_pg_member", PublicID: created.PublicID, ConversationID: fixture.conversationID})
	if err != nil || memberView.Counts[memberView.Options[0].ID] != 0 || memberView.VoteCount == nil || *memberView.VoteCount != 0 {
		t.Fatalf("member view = %+v err=%v", memberView, err)
	}
	listed, err := fixture.service.List(fixture.ctx, ListInput{ActorID: "usr_sol_pg_member", Status: StatusOpen, Limit: 10, ConversationID: fixture.conversationID})
	if err != nil || len(listed) != 1 || listed[0].PublicID != created.PublicID {
		t.Fatalf("member list = %+v err=%v", listed, err)
	}

	voted, err := fixture.service.Vote(fixture.ctx, VoteInput{ActorID: "usr_sol_pg_member", PublicID: created.PublicID, ConversationID: fixture.conversationID, OptionIDs: []string{open.Options[0].ID}, ExpectedRevision: 2, IdempotencyKey: "sol-vote-1"})
	if err != nil || voted.Revision != 3 || voted.Counts[open.Options[0].ID] != 1 || len(voted.SelectedOptionIDs) != 1 {
		t.Fatalf("vote = %+v err=%v", voted, err)
	}
	voteReplay, err := fixture.service.Vote(fixture.ctx, VoteInput{ActorID: "usr_sol_pg_member", PublicID: created.PublicID, ConversationID: fixture.conversationID, OptionIDs: []string{open.Options[0].ID}, ExpectedRevision: 2, IdempotencyKey: "sol-vote-1"})
	if err != nil || !reflect.DeepEqual(voteReplay, voted) {
		t.Fatalf("vote replay = %+v err=%v want %+v", voteReplay, err, voted)
	}
	if _, err := fixture.service.Vote(fixture.ctx, VoteInput{ActorID: "usr_sol_pg_member", PublicID: created.PublicID, ConversationID: fixture.conversationID, OptionIDs: []string{open.Options[1].ID}, ExpectedRevision: 2, IdempotencyKey: "sol-vote-stale"}); pgSolicitationCode(err) != CodeRevisionConflict {
		t.Fatalf("stale vote code = %q err=%v", pgSolicitationCode(err), err)
	}

	votes, err := fixture.service.ListVotes(fixture.ctx, VotesInput{ActorID: "usr_sol_pg_owner", PublicID: created.PublicID})
	if err != nil || len(votes) != 1 || votes[0].VoterUserID != "usr_sol_pg_member" {
		t.Fatalf("owner votes = %+v err=%v", votes, err)
	}
	closed, err := fixture.service.Close(fixture.ctx, TransitionInput{ActorID: "usr_sol_pg_owner", PublicID: created.PublicID, ExpectedRevision: 3, IdempotencyKey: "sol-close-1"})
	if err != nil || closed.Status != StatusClosed || closed.Revision != 4 {
		t.Fatalf("close = %+v err=%v", closed, err)
	}
	if _, err := fixture.service.Vote(fixture.ctx, VoteInput{ActorID: "usr_sol_pg_member", PublicID: created.PublicID, ConversationID: fixture.conversationID, OptionIDs: []string{open.Options[1].ID}, IdempotencyKey: "sol-vote-closed"}); pgSolicitationCode(err) != CodeVoteClosed {
		t.Fatalf("closed vote code = %q err=%v", pgSolicitationCode(err), err)
	}
	deliveries, err := fixture.service.ListDeliveries(fixture.ctx, DeliveriesInput{ActorID: "usr_sol_pg_owner", PublicID: created.PublicID})
	if err != nil || len(deliveries) != 4 {
		t.Fatalf("deliveries = %d err=%v", len(deliveries), err)
	}

	for _, action := range []string{"echo.solicitation.create", "echo.solicitation.publish", "echo.solicitation.vote", "echo.solicitation.close"} {
		if got := pgSolicitationCount(t, fixture, `SELECT COUNT(*) FROM audit_logs WHERE action = $1 AND result = 'success'`, action); got != 1 {
			t.Fatalf("success audit %s = %d", action, got)
		}
	}
	if got := pgSolicitationCount(t, fixture, `SELECT COUNT(*) FROM workspace_events WHERE space_id = $1`, DefaultSpaceID); got != 4 {
		t.Fatalf("event count = %d, want 4", got)
	}
	rows, err := fixture.pool.Query(fixture.ctx, `SELECT type, payload_json FROM workspace_events WHERE space_id = $1 ORDER BY seq`, DefaultSpaceID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	expectedEventTypes := []string{"echo.solicitation.updated", "echo.solicitation.published", "echo.solicitation.updated", "echo.solicitation.closed"}
	eventIndex := 0
	for rows.Next() {
		var eventType, payloadJSON string
		if err := rows.Scan(&eventType, &payloadJSON); err != nil {
			t.Fatal(err)
		}
		if eventIndex >= len(expectedEventTypes) {
			t.Fatalf("unexpected event[%d] type = %q", eventIndex, eventType)
		}
		if eventType != expectedEventTypes[eventIndex] {
			t.Fatalf("event[%d] type = %q, want %q", eventIndex, eventType, expectedEventTypes[eventIndex])
		}
		eventIndex++
		var payload map[string]any
		if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
			t.Fatal(err)
		}
		if _, ok := payload["description"]; ok {
			t.Fatalf("event %s contains solicitation description", eventType)
		}
		if _, ok := payload["options"]; ok {
			t.Fatalf("event %s contains solicitation options", eventType)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if eventIndex != len(expectedEventTypes) {
		t.Fatalf("event rows = %d, want %d", eventIndex, len(expectedEventTypes))
	}
}

func TestPGSolicitationTargetAndRoleBoundaries(t *testing.T) {
	fixture := newPGSolicitationIntegrationFixture(t)
	created, err := fixture.service.Create(fixture.ctx, pgSolicitationCreateInput("sol-target-1"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.Publish(fixture.ctx, TransitionInput{ActorID: "usr_sol_pg_owner", PublicID: created.PublicID, IdempotencyKey: "sol-target-publish"}); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.Get(fixture.ctx, GetInput{ActorID: "usr_sol_pg_other", PublicID: created.PublicID, ConversationID: fixture.conversationID}); pgSolicitationCode(err) != CodeSolicitationNotFound {
		t.Fatalf("non-member target code = %q err=%v", pgSolicitationCode(err), err)
	}
	if _, err := fixture.service.Vote(fixture.ctx, VoteInput{ActorID: "usr_sol_pg_auditor", PublicID: created.PublicID, ConversationID: fixture.conversationID, OptionIDs: []string{"missing"}, IdempotencyKey: "sol-auditor-vote"}); pgSolicitationCode(err) != CodeSolicitationNotFound {
		t.Fatalf("auditor vote code = %q err=%v", pgSolicitationCode(err), err)
	}
	if _, err := fixture.service.ListVotes(fixture.ctx, VotesInput{ActorID: "usr_sol_pg_member", PublicID: created.PublicID}); pgSolicitationCode(err) != CodeSolicitationNotFound {
		t.Fatalf("member voter details code = %q err=%v", pgSolicitationCode(err), err)
	}
}

func TestPGSolicitationConcurrentSequenceAndSameKeyReplay(t *testing.T) {
	fixture := newPGSolicitationIntegrationFixture(t)
	const count = 8
	results := make(chan *Solicitation, count)
	errs := make(chan error, count)
	var wait sync.WaitGroup
	for index := 0; index < count; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			input := pgSolicitationCreateInput(fmt.Sprintf("sol-parallel-%d", index))
			result, err := fixture.service.Create(fixture.ctx, input)
			results <- result
			errs <- err
		}(index)
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
			t.Fatalf("duplicate or missing result: %+v", result)
		}
		seen[result.PublicID] = true
	}
	if len(seen) != count {
		t.Fatalf("got %d public IDs, want %d", len(seen), count)
	}
	const sameKey = "sol-same-key"
	sameErrors := make(chan error, 4)
	var sameWait sync.WaitGroup
	for index := 0; index < 4; index++ {
		sameWait.Add(1)
		go func() {
			defer sameWait.Done()
			result, err := fixture.service.Create(fixture.ctx, pgSolicitationCreateInput(sameKey))
			if err != nil {
				sameErrors <- err
			}
			if result == nil {
				sameErrors <- errors.New("same-key create returned nil")
			}
		}()
	}
	sameWait.Wait()
	close(sameErrors)
	for err := range sameErrors {
		t.Fatal(err)
	}
	if err := pgSolicitationCount(t, fixture, `SELECT COUNT(*) FROM echo_solicitations WHERE space_id = $1 AND idempotency_key = $2`, DefaultSpaceID, sameKey); err != 1 {
		t.Fatalf("same-key solicitation count = %d", err)
	}
}

// TestPGSolicitationInTxCommitAndInfrastructureRollback exercises the typed
// transaction bridge on one acquired PostgreSQL connection. Domain rejection
// audits commit through the caller-owned transaction; an injected persistence
// failure rolls back the preceding vote, event, and idempotency writes.
func TestPGSolicitationInTxCommitAndInfrastructureRollback(t *testing.T) {
	fixture := newPGSolicitationIntegrationFixture(t)
	created, err := fixture.service.Create(fixture.ctx, pgSolicitationCreateInput("sol-tx-create"))
	if err != nil {
		t.Fatal(err)
	}
	open, err := fixture.service.Publish(fixture.ctx, TransitionInput{ActorID: "usr_sol_pg_owner", PublicID: created.PublicID, ExpectedRevision: 1, IdempotencyKey: "sol-tx-publish"})
	if err != nil {
		t.Fatal(err)
	}

	connection := acquirePGSolicitationConnection(t, fixture)
	transaction, err := connection.Begin(fixture.ctx)
	if err != nil {
		t.Fatal(err)
	}
	repository := fixture.service.Repository().(*PGRepository)
	result, err := fixture.service.VoteInTx(fixture.ctx, repository.NewTransaction(transaction), VoteInput{
		ActorID: "usr_sol_pg_member", PublicID: open.PublicID, OptionIDs: []string{open.Options[0].ID},
		ExpectedRevision: open.Revision, IdempotencyKey: "sol-tx-vote",
	})
	if err != nil {
		_ = transaction.Rollback(fixture.ctx)
		t.Fatalf("VoteInTx: %v", err)
	}
	if result == nil || result.Revision != open.Revision+1 {
		t.Fatalf("VoteInTx result = %+v", result)
	}
	if err := transaction.Commit(fixture.ctx); err != nil {
		t.Fatal(err)
	}
	if got := pgSolicitationCount(t, fixture, `SELECT COUNT(*) FROM echo_solicitation_votes WHERE solicitation_id = (SELECT id FROM echo_solicitations WHERE public_id = $1)`, open.PublicID); got != 1 {
		t.Fatalf("committed vote count = %d", got)
	}

	connection = acquirePGSolicitationConnection(t, fixture)
	transaction, err = connection.Begin(fixture.ctx)
	if err != nil {
		t.Fatal(err)
	}
	failedTx := &failingSolicitationTx{Tx: repository.NewTransaction(transaction)}
	_, err = fixture.service.VoteInTx(fixture.ctx, failedTx, VoteInput{
		ActorID: "usr_sol_pg_member", PublicID: open.PublicID, OptionIDs: []string{open.Options[1].ID},
		ExpectedRevision: open.Revision + 1, IdempotencyKey: "sol-tx-fault",
	})
	if err == nil || errors.As(err, new(*TransactionRejection)) {
		_ = transaction.Rollback(fixture.ctx)
		t.Fatalf("faulted VoteInTx error = %v, want infrastructure error", err)
	}
	if err := transaction.Rollback(fixture.ctx); err != nil {
		t.Fatal(err)
	}
	if got := pgSolicitationCount(t, fixture, `SELECT COUNT(*) FROM echo_solicitation_votes WHERE solicitation_id = (SELECT id FROM echo_solicitations WHERE public_id = $1)`, open.PublicID); got != 1 {
		t.Fatalf("rolled-back vote count = %d", got)
	}
	if got := pgSolicitationCount(t, fixture, `SELECT revision FROM echo_solicitations WHERE public_id = $1`, open.PublicID); got != open.Revision+1 {
		t.Fatalf("rolled-back solicitation revision = %d", got)
	}

	connection = acquirePGSolicitationConnection(t, fixture)
	transaction, err = connection.Begin(fixture.ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, err = fixture.service.VoteInTx(fixture.ctx, repository.NewTransaction(transaction), VoteInput{
		ActorID: "usr_sol_pg_member", PublicID: open.PublicID, OptionIDs: []string{open.Options[1].ID},
		ExpectedRevision: open.Revision, IdempotencyKey: "sol-tx-rejected",
	})
	var rejected *TransactionRejection
	if !errors.As(err, &rejected) || rejected == nil {
		_ = transaction.Rollback(fixture.ctx)
		t.Fatalf("stale VoteInTx error = %v, want TransactionRejection", err)
	}
	if err := transaction.Commit(fixture.ctx); err != nil {
		t.Fatal(err)
	}
	if got := pgSolicitationCount(t, fixture, `SELECT COUNT(*) FROM audit_logs WHERE action = 'echo.solicitation.vote' AND result = 'rejected'`); got != 1 {
		t.Fatalf("rejection audit count = %d", got)
	}
}

func TestPGSolicitationConcurrentRepeatedVoteUsesOneIdempotentRow(t *testing.T) {
	fixture := newPGSolicitationIntegrationFixture(t)
	created, err := fixture.service.Create(fixture.ctx, pgSolicitationCreateInput("sol-repeat-create"))
	if err != nil {
		t.Fatal(err)
	}
	open, err := fixture.service.Publish(fixture.ctx, TransitionInput{ActorID: "usr_sol_pg_owner", PublicID: created.PublicID, ExpectedRevision: 1, IdempotencyKey: "sol-repeat-publish"})
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	for range 2 {
		go func() {
			<-start
			_, voteErr := fixture.service.Vote(fixture.ctx, VoteInput{
				ActorID: "usr_sol_pg_member", PublicID: open.PublicID, OptionIDs: []string{open.Options[0].ID},
				ExpectedRevision: open.Revision, IdempotencyKey: "sol-repeat-vote",
			})
			results <- voteErr
		}()
	}
	close(start)
	for range 2 {
		if err := <-results; err != nil {
			t.Fatalf("concurrent repeated vote: %v", err)
		}
	}
	if got := pgSolicitationCount(t, fixture, `SELECT COUNT(*) FROM echo_solicitation_votes WHERE solicitation_id = (SELECT id FROM echo_solicitations WHERE public_id = $1)`, open.PublicID); got != 1 {
		t.Fatalf("repeated vote count = %d", got)
	}
	if got := pgSolicitationCount(t, fixture, `SELECT COUNT(*) FROM echo_solicitation_idempotency WHERE solicitation_id = (SELECT id FROM echo_solicitations WHERE public_id = $1) AND operation = 'vote' AND idempotency_key = 'sol-repeat-vote'`, open.PublicID); got != 1 {
		t.Fatalf("repeated vote idempotency count = %d", got)
	}
}

func acquirePGSolicitationConnection(t *testing.T, fixture *pgSolicitationIntegrationFixture) *pgxpool.Conn {
	t.Helper()
	connection, err := fixture.pool.Acquire(fixture.ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(connection.Release)
	return connection
}

type failingSolicitationTx struct {
	Tx
}

func (*failingSolicitationTx) WriteAudit(context.Context, AuditInput) error {
	return errors.New("synthetic solicitation audit write failure")
}
