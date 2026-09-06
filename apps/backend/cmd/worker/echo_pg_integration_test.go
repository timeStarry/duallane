//go:build postgres_integration

package main

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
	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	"github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
)

func TestEchoWorkerDurableRecoveryAcrossProcessorConstruction(t *testing.T) {
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

	schema := fmt.Sprintf("duallane_echo_worker_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		if _, err := conn.Exec(cleanupCtx, "DROP SCHEMA IF EXISTS "+identifier+" CASCADE"); err != nil {
			t.Errorf("drop synthetic Echo worker schema: %v", err)
		}
	})
	if _, err := conn.Exec(ctx, "SET search_path TO "+identifier); err != nil {
		t.Fatal(err)
	}
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	migrationDirectory := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../web/server/migrations"))
	if _, err := (migrations.Runner{
		Beginner: postgres.NewMigrationBeginner(conn), Directory: migrationDirectory,
	}).Run(ctx); err != nil {
		t.Fatal(err)
	}

	const (
		spaceID      = "spc_default"
		ownerID      = "echo-worker-owner"
		recipientID  = "echo-worker-recipient"
		lateMemberID = "echo-worker-late-member"
		solicitation = "echo-worker-solicitation"
		deliveryID   = "echo-worker-delivery"
	)
	now := time.Date(2026, 9, 6, 13, 0, 0, 0, time.UTC)
	mustExecEchoWorker(t, ctx, conn, `INSERT INTO users (id, github_id, github_login, email, display_name, kind, created_at) VALUES
 ('usr_system_echo', 'echo-system-github', '__duallane_echo__', NULL, 'Echo', 'bot', $1),
 ($2, 'echo-owner-github', 'echo-worker-owner', NULL, 'Synthetic owner', 'human', $1),
 ($3, 'echo-recipient-github', 'echo-worker-recipient', 'echo-recipient@example.test', 'Synthetic recipient', 'human', $1)`, now, ownerID, recipientID)
	mustExecEchoWorker(t, ctx, conn, `INSERT INTO spaces (id, name, slug, created_by, created_at) VALUES ($1, 'Synthetic Echo worker', 'echo-worker-synthetic', $2, $3)`, spaceID, ownerID, now)
	mustExecEchoWorker(t, ctx, conn, `INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES
 ($1, $2, 'owner', $3), ($1, $4, 'member', $3), ($1, 'usr_system_echo', 'member', $3)`, spaceID, ownerID, now, recipientID)
	mustExecEchoWorker(t, ctx, conn, `INSERT INTO space_email_settings (
 space_id, enabled, smtp_host, smtp_port, encryption, username, from_address, from_name,
 password_ciphertext, active_from, last_tested_at, last_test_status, last_test_error_code, updated_by, updated_at
 ) VALUES ($1, 1, 'smtp.synthetic.test', 2525, 'none', NULL, 'echo@example.test', 'Synthetic Echo', NULL,
 '1970-01-01T00:00:00Z', $2, 'success', NULL, $3, $2)`, spaceID, now, ownerID)
	mustExecEchoWorker(t, ctx, conn, `INSERT INTO user_notification_preferences (
 user_id, email, email_source, email_verified_at, enabled, immediate_enabled, digest_enabled, updated_at
 ) VALUES ($1, 'echo-recipient@example.test', 'custom', $2, 1, 1, 0, $2)`, recipientID, now)
	mustExecEchoWorker(t, ctx, conn, `INSERT INTO workspace_ntfy_preferences (
 user_id, topic, enabled, created_at, rotated_at, updated_at
 ) VALUES ($1, 'duallane-echo-worker-recipient-abc123', 1, $2, NULL, $2)`, recipientID, now)
	mustExecEchoWorker(t, ctx, conn, `INSERT INTO echo_solicitations (
 id, public_id, space_id, owner_user_id, title, description, question,
 choice_mode, min_selections, max_selections, allow_vote_change,
 result_visibility, delivery_policy, status, revision, created_at, updated_at, published_at
 ) VALUES ($1, 'SOL-2026-0001', $2, $3, 'Synthetic title', 'Synthetic description',
 'Synthetic question?', 'single', 1, 1, TRUE, 'aggregate', 'all_active_members',
 'open', 1, $4, $4, $4)`, solicitation, spaceID, ownerID, now)
	mustExecEchoWorker(t, ctx, conn, `INSERT INTO echo_solicitation_options (id, solicitation_id, label, position) VALUES
 ('echo-worker-option-a', $1, 'Synthetic A', 0), ('echo-worker-option-b', $1, 'Synthetic B', 1)`, solicitation)
	mustExecEchoWorker(t, ctx, conn, `INSERT INTO echo_solicitation_deliveries (
 id, space_id, solicitation_id, recipient_user_id, status, attempt_count, created_at, updated_at
 ) VALUES ($1, $2, $3, $4, 'pending', 0, $5, $5)`, deliveryID, spaceID, solicitation, recipientID, now)

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

	catalogPath := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../web/shared/echo-release-guides.json"))
	runtimeConfig := &config.WorkspaceConfig{
		Enabled: true, ReleaseCatalogPath: catalogPath,
		FrontendURL: "https://frontend.synthetic.test", NtfyBaseURL: "https://ntfy.synthetic.test",
	}
	processors, err := newEchoProcessors(pool, runtimeConfig)
	if err != nil {
		t.Fatal(err)
	}
	byName := echoWorkerProcessorsByName(t, processors)
	for _, name := range []string{echoRequirementProcessorName, echoReleaseProcessorName} {
		result, err := byName[name].process(ctx)
		if err != nil {
			t.Fatalf("empty %s Echo cycle: %v", name, err)
		}
		if result.Claimed != 0 || result.Sent != 0 || result.Failed != 0 {
			t.Fatalf("empty %s Echo cycle result = %+v", name, result)
		}
	}
	first, err := byName[echoSolicitationProcessorName].process(ctx)
	if err != nil {
		t.Fatalf("first Echo cycle: %v", err)
	}
	if first.Claimed != 1 || first.Sent != 1 || first.Failed != 0 {
		t.Fatalf("first Echo cycle result = %+v", first)
	}
	assertEchoWorkerCount(t, pool, ctx, `SELECT COUNT(*) FROM echo_solicitation_deliveries WHERE id = $1 AND status = 'sent' AND attempt_count = 1`, 1, deliveryID)
	assertEchoWorkerNotificationJobs(t, pool, ctx, recipientID, spaceID)

	// Reconstruct the complete composition to model a process restart. The
	// second processor starts with an empty in-memory cursor, so this assertion
	// proves that the durable delivery state and card/message idempotency, not a
	// process-local cursor, prevents duplicate effects.
	secondProcessors, err := newEchoProcessors(pool, runtimeConfig)
	if err != nil {
		t.Fatal(err)
	}
	second := echoWorkerProcessorsByName(t, secondProcessors)
	replayed, err := second[echoSolicitationProcessorName].process(ctx)
	if err != nil {
		t.Fatalf("recovery Echo cycle: %v", err)
	}
	if replayed.Claimed != 1 || replayed.Sent != 1 || replayed.Failed != 0 {
		t.Fatalf("recovery Echo cycle result = %+v", replayed)
	}
	assertEchoWorkerCount(t, pool, ctx, `SELECT COUNT(*) FROM workspace_cards WHERE source_kind = 'echo'`, 1)
	assertEchoWorkerCount(t, pool, ctx, `SELECT COUNT(*) FROM messages WHERE author_id = 'usr_system_echo'`, 1)
	assertEchoWorkerCount(t, pool, ctx, `SELECT COUNT(*) FROM echo_solicitation_deliveries WHERE id = $1 AND status = 'sent' AND attempt_count = 1`, 1, deliveryID)
	assertEchoWorkerNotificationJobs(t, pool, ctx, recipientID, spaceID)

	// Model a member joining after publication when the post-commit HTTP hook
	// never ran. Reconciliation must discover the active human through its
	// bounded keyset page and let SyncMember create the missing row.
	mustExecEchoWorker(t, ctx, conn, `INSERT INTO users (id, github_id, github_login, display_name, kind, created_at) VALUES
 ($1, 'echo-late-member-github', 'echo-worker-late-member', 'Synthetic late member', 'human', $2)`, lateMemberID, now)
	mustExecEchoWorker(t, ctx, conn, `INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES ($1, $2, 'member', $3)`, spaceID, lateMemberID, now)
	memberCycle, err := byName[echoMemberReconciliationProcessorName].process(ctx)
	if err != nil {
		t.Fatalf("member reconciliation cycle: %v", err)
	}
	if memberCycle.Claimed != 3 || memberCycle.Failed != 0 || memberCycle.Cancelled != 0 {
		t.Fatalf("member reconciliation result = %+v", memberCycle)
	}
	assertEchoWorkerCount(t, pool, ctx, `SELECT COUNT(*) FROM echo_solicitation_deliveries WHERE solicitation_id = $1 AND recipient_user_id = $2`, 1, solicitation, lateMemberID)
	assertEchoWorkerCount(t, pool, ctx, `SELECT COUNT(*) FROM echo_solicitation_deliveries WHERE solicitation_id = $1 AND recipient_user_id = $2 AND status = 'sent' AND attempt_count = 1`, 1, solicitation, lateMemberID)
	assertEchoWorkerCount(t, pool, ctx, `SELECT COUNT(*) FROM workspace_cards WHERE source_kind = 'echo' AND source_id = 'sol:' || $1 || ':' || $2`, 1, solicitation, lateMemberID)
	assertEchoWorkerCount(t, pool, ctx, `
SELECT COUNT(*)
FROM messages m
INNER JOIN conversations c ON c.id = m.conversation_id
WHERE m.author_id = 'usr_system_echo'
  AND c.space_id = $1
  AND c.direct_key = LEAST($2::text, 'usr_system_echo') || ':' || GREATEST($2::text, 'usr_system_echo')`, 1, spaceID, lateMemberID)

	// The page is short, so the in-memory cursor wraps. A repeated cycle must
	// still be safe: durable delivery/card/message idempotency keeps the late
	// member at one effect of each kind.
	repeatedMemberCycle, err := byName[echoMemberReconciliationProcessorName].process(ctx)
	if err != nil {
		t.Fatalf("repeated member reconciliation cycle: %v", err)
	}
	if repeatedMemberCycle.Claimed != 3 || repeatedMemberCycle.Failed != 0 || repeatedMemberCycle.Cancelled != 0 {
		t.Fatalf("repeated member reconciliation result = %+v", repeatedMemberCycle)
	}
	assertEchoWorkerCount(t, pool, ctx, `SELECT COUNT(*) FROM echo_solicitation_deliveries WHERE solicitation_id = $1 AND recipient_user_id = $2`, 1, solicitation, lateMemberID)
	assertEchoWorkerCount(t, pool, ctx, `SELECT COUNT(*) FROM echo_solicitation_deliveries WHERE solicitation_id = $1 AND recipient_user_id = $2 AND status = 'sent' AND attempt_count = 1`, 1, solicitation, lateMemberID)
	assertEchoWorkerCount(t, pool, ctx, `SELECT COUNT(*) FROM workspace_cards WHERE source_kind = 'echo' AND source_id = 'sol:' || $1 || ':' || $2`, 1, solicitation, lateMemberID)
	assertEchoWorkerCount(t, pool, ctx, `
SELECT COUNT(*)
FROM messages m
INNER JOIN conversations c ON c.id = m.conversation_id
WHERE m.author_id = 'usr_system_echo'
  AND c.space_id = $1
  AND c.direct_key = LEAST($2::text, 'usr_system_echo') || ':' || GREATEST($2::text, 'usr_system_echo')`, 1, spaceID, lateMemberID)
}

func echoWorkerProcessorsByName(t *testing.T, processors []workerProcessor) map[string]workerProcessor {
	t.Helper()
	result := make(map[string]workerProcessor, len(processors))
	for _, processor := range processors {
		if processor.process == nil {
			t.Fatalf("Echo processor %q has no process function", processor.name)
		}
		result[processor.name] = processor
	}
	for _, name := range []string{echoSolicitationProcessorName, echoRequirementProcessorName, echoReleaseProcessorName, echoMemberReconciliationProcessorName} {
		if _, ok := result[name]; !ok {
			t.Fatalf("Echo processor %q is missing", name)
		}
	}
	return result
}

func mustExecEchoWorker(t *testing.T, ctx context.Context, conn *pgx.Conn, query string, args ...any) {
	t.Helper()
	if _, err := conn.Exec(ctx, query, args...); err != nil {
		t.Fatal(err)
	}
}

func assertEchoWorkerCount(t *testing.T, pool *pgxpool.Pool, ctx context.Context, query string, want int, args ...any) {
	t.Helper()
	var got int
	if err := pool.QueryRow(ctx, query, args...).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("count = %d, want %d", got, want)
	}
}

func assertEchoWorkerNotificationJobs(t *testing.T, pool *pgxpool.Pool, ctx context.Context, userID, spaceID string) {
	t.Helper()
	const emailJobs = `
SELECT COUNT(*)
FROM workspace_email_jobs j
INNER JOIN messages m ON m.id = j.message_id
INNER JOIN conversations c ON c.id = m.conversation_id
WHERE j.user_id = $1 AND c.space_id = $2 AND m.author_id = 'usr_system_echo'
  AND c.direct_key = LEAST($1::text, 'usr_system_echo') || ':' || GREATEST($1::text, 'usr_system_echo')`
	const ntfyJobs = `
SELECT COUNT(*)
FROM workspace_ntfy_jobs j
INNER JOIN messages m ON m.id = j.message_id
INNER JOIN conversations c ON c.id = m.conversation_id
WHERE j.user_id = $1 AND c.space_id = $2 AND m.author_id = 'usr_system_echo'
  AND c.direct_key = LEAST($1::text, 'usr_system_echo') || ':' || GREATEST($1::text, 'usr_system_echo')`
	assertEchoWorkerCount(t, pool, ctx, emailJobs, 1, userID, spaceID)
	assertEchoWorkerCount(t, pool, ctx, ntfyJobs, 1, userID, spaceID)
	assertEchoWorkerCount(t, pool, ctx, emailJobs+" AND j.status = 'pending' AND j.attempt_count = 0", 1, userID, spaceID)
	assertEchoWorkerCount(t, pool, ctx, ntfyJobs+" AND j.status = 'pending' AND j.attempt_count = 0", 1, userID, spaceID)
}
