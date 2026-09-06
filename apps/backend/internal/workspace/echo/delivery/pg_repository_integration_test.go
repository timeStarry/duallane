//go:build postgres_integration

package delivery

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	platformmigrations "github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
)

func TestPGDeliveryClaimConversationAndFailureAtomicity(t *testing.T) {
	fixture := newPGDeliveryIntegrationFixture(t)
	firstClaimed := make(chan struct{})
	releaseFirst := make(chan struct{})
	firstDone := make(chan error, 1)
	secondDone := make(chan bool, 1)

	go func() {
		firstDone <- fixture.repository.WithTx(fixture.ctx, func(tx Tx) error {
			row, claimed, err := tx.ClaimSolicitationDelivery(fixture.ctx, fixture.spaceID, fixture.deliveryID)
			if err != nil {
				return err
			}
			if !claimed || row == nil {
				return fmt.Errorf("first worker did not claim delivery")
			}
			close(firstClaimed)
			<-releaseFirst
			return nil
		})
	}()
	<-firstClaimed

	go func() {
		err := fixture.repository.WithTx(fixture.ctx, func(tx Tx) error {
			_, claimed, err := tx.ClaimSolicitationDelivery(fixture.ctx, fixture.spaceID, fixture.deliveryID)
			if err != nil {
				return err
			}
			secondDone <- claimed
			return nil
		})
		if err != nil {
			secondDone <- true
		}
	}()
	if claimed := <-secondDone; claimed {
		t.Fatal("second worker claimed a row held by first worker")
	}
	close(releaseFirst)
	if err := <-firstDone; err != nil {
		t.Fatalf("first worker: %v", err)
	}
	if err := fixture.repository.WithTx(fixture.ctx, func(tx Tx) error {
		row, err := tx.GetSolicitation(fixture.ctx, fixture.spaceID, "SOL-2026-0001")
		if err != nil {
			return err
		}
		if row == nil || row.Revision != 1 {
			return fmt.Errorf("locked solicitation = %+v", row)
		}
		return nil
	}); err != nil {
		t.Fatalf("read source under delivery lock: %v", err)
	}

	var firstConversation, secondConversation *DirectConversation
	if err := fixture.repository.WithTx(fixture.ctx, func(tx Tx) error {
		var err error
		firstConversation, err = tx.EnsureEchoDirectConversation(fixture.ctx, fixture.spaceID, fixture.memberID, EchoUserID, fixture.now)
		return err
	}); err != nil {
		t.Fatalf("create Echo direct conversation: %v", err)
	}
	if err := fixture.repository.WithTx(fixture.ctx, func(tx Tx) error {
		var err error
		secondConversation, err = tx.EnsureEchoDirectConversation(fixture.ctx, fixture.spaceID, fixture.memberID, EchoUserID, fixture.now)
		return err
	}); err != nil {
		t.Fatalf("reuse Echo direct conversation: %v", err)
	}
	if firstConversation == nil || secondConversation == nil || firstConversation.ID != secondConversation.ID || !secondConversation.Reused {
		t.Fatalf("conversation reuse = first:%+v second:%+v", firstConversation, secondConversation)
	}
	assertPGDeliveryCount(t, fixture, `SELECT COUNT(*) FROM conversations WHERE space_id = $1 AND direct_key = $2`, int64(1), fixture.spaceID, directConversationKey(fixture.memberID, EchoUserID))
	assertPGDeliveryCount(t, fixture, `SELECT COUNT(*) FROM conversation_members WHERE conversation_id = $1`, int64(2), firstConversation.ID)
	assertPGDeliveryCount(t, fixture, `SELECT COUNT(*) FROM workspace_events WHERE space_id = $1 AND type = 'conversation.created'`, int64(1), fixture.spaceID)

	if err := fixture.repository.WithTx(fixture.ctx, func(tx Tx) error {
		row, claimed, err := tx.ClaimSolicitationDelivery(fixture.ctx, fixture.spaceID, fixture.deliveryID)
		if err != nil || !claimed || row == nil {
			return fmt.Errorf("claim for failure transition: row=%+v claimed=%v err=%v", row, claimed, err)
		}
		if err := tx.MarkSolicitationDelivery(fixture.ctx, fixture.spaceID, fixture.deliveryID, DeliveryFailed, "echo.writer_unavailable", fixture.now); err != nil {
			return err
		}
		return tx.WriteAudit(fixture.ctx, AuditInput{SpaceID: fixture.spaceID, ActorUserID: EchoUserID, ActorGitHubLogin: EchoGitHubLogin, Action: "echo.delivery", TargetType: "echo.delivery", TargetID: fixture.deliveryID, Result: "failure", Reason: "echo.writer_unavailable", CreatedAt: fixture.now})
	}); err != nil {
		t.Fatalf("failure transition: %v", err)
	}
	assertPGDeliveryCount(t, fixture, `SELECT COUNT(*) FROM echo_solicitation_deliveries WHERE id = $1 AND status = 'failed' AND attempt_count = 1 AND last_error_code = 'echo.writer_unavailable'`, int64(1), fixture.deliveryID)
	assertPGDeliveryCount(t, fixture, `SELECT COUNT(*) FROM audit_logs WHERE action = 'echo.delivery' AND target_id = $1 AND result = 'failure'`, int64(1), fixture.deliveryID)
}

type pgDeliveryIntegrationFixture struct {
	ctx        context.Context
	pool       *pgxpool.Pool
	repository *PGRepository
	spaceID    string
	memberID   string
	deliveryID string
	now        time.Time
}

func newPGDeliveryIntegrationFixture(t *testing.T) *pgDeliveryIntegrationFixture {
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
	schema := fmt.Sprintf("duallane_echo_delivery_%d", time.Now().UnixNano())
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
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	seedPGDeliveryData(t, ctx, conn, now)
	poolConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	poolConfig.ConnConfig.RuntimeParams["search_path"] = schema
	poolConfig.MaxConns = 4
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return &pgDeliveryIntegrationFixture{
		ctx: ctx, pool: pool, repository: NewPGRepository(pool), spaceID: "spc_echo_delivery",
		memberID: "usr_echo_delivery_member", deliveryID: "echo_delivery_row_1", now: now,
	}
}

func seedPGDeliveryData(t *testing.T, ctx context.Context, conn *pgx.Conn, now time.Time) {
	t.Helper()
	for _, user := range []struct{ id, login, display, kind string }{
		{EchoUserID, EchoGitHubLogin, "回声", "bot"},
		{"usr_echo_delivery_owner", "echo-delivery-owner", "Echo owner", "human"},
		{"usr_echo_delivery_member", "echo-delivery-member", "Echo member", "human"},
	} {
		mustExecPGDelivery(t, ctx, conn, `INSERT INTO users (id, github_login, display_name, kind, created_at) VALUES ($1, $2, $3, $4, $5)`, user.id, user.login, user.display, user.kind, now)
	}
	mustExecPGDelivery(t, ctx, conn, `INSERT INTO spaces (id, name, slug, created_by, created_at) VALUES ($1, 'Echo delivery integration', 'echo-delivery-integration', $2, $3)`, "spc_echo_delivery", "usr_echo_delivery_owner", now)
	for _, member := range []struct{ id, role string }{
		{"usr_echo_delivery_owner", "owner"}, {"usr_echo_delivery_member", "member"}, {EchoUserID, "member"},
	} {
		mustExecPGDelivery(t, ctx, conn, `INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4)`, "spc_echo_delivery", member.id, member.role, now)
	}
	mustExecPGDelivery(t, ctx, conn, `INSERT INTO echo_solicitations (id, public_id, space_id, owner_user_id, title, description, question, choice_mode, min_selections, max_selections, allow_vote_change, result_visibility, delivery_policy, status, deadline, revision, idempotency_key, created_at, updated_at, published_at, closed_at, withdrawn_at) VALUES ($1, 'SOL-2026-0001', $2, $3, 'Synthetic', 'Synthetic', 'Synthetic?', 'single', 1, 1, true, 'aggregate', 'all_active_members', 'open', NULL, 1, NULL, $4, $4, $4, NULL, NULL)`, "sol-delivery-1", "spc_echo_delivery", "usr_echo_delivery_owner", now)
	mustExecPGDelivery(t, ctx, conn, `INSERT INTO echo_solicitation_deliveries (id, space_id, solicitation_id, recipient_user_id, status, attempt_count, last_error_code, delivered_at, created_at, updated_at) VALUES ($1, $2, $3, $4, 'pending', 0, NULL, NULL, $5, $5)`, "echo_delivery_row_1", "spc_echo_delivery", "sol-delivery-1", "usr_echo_delivery_member", now)
}

func mustExecPGDelivery(t *testing.T, ctx context.Context, conn *pgx.Conn, query string, args ...any) {
	t.Helper()
	if _, err := conn.Exec(ctx, query, args...); err != nil {
		t.Fatal(err)
	}
}

func assertPGDeliveryCount(t *testing.T, fixture *pgDeliveryIntegrationFixture, query string, want int64, args ...any) {
	t.Helper()
	var got int64
	if err := fixture.pool.QueryRow(fixture.ctx, query, args...).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("count = %d, want %d", got, want)
	}
}
