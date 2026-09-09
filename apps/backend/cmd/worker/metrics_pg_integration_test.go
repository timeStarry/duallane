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
	platformmetrics "github.com/timestarry/duallane/apps/backend/internal/platform/metrics"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	"github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/files"
)

func TestCollectWorkerBacklogPostgresReadOnly(t *testing.T) {
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

	schema := fmt.Sprintf("duallane_worker_metrics_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		if _, err := conn.Exec(cleanupCtx, "DROP SCHEMA IF EXISTS "+identifier+" CASCADE"); err != nil {
			t.Errorf("drop synthetic worker metrics schema: %v", err)
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

	now := time.Now().UTC().Truncate(time.Microsecond)
	seedWorkerMetricsFixture(t, ctx, conn, now)

	poolConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	poolConfig.ConnConfig.RuntimeParams["search_path"] = schema
	poolConfig.MaxConns = 2
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	recorder := &workerBacklogRecorderSpy{}
	if err := collectWorkerBacklog(ctx, pool, recorder); err != nil {
		t.Fatal(err)
	}
	assertWorkerMetricSnapshot(t, recorder, platformmetrics.WorkerOperationEmail, 2, 4*time.Hour)
	assertWorkerMetricSnapshot(t, recorder, platformmetrics.WorkerOperationNtfy, 1, 90*time.Minute)
	assertWorkerMetricSnapshot(t, recorder, platformmetrics.WorkerOperationEchoSolicitationDelivery, 2, 3*time.Hour)
	assertWorkerMetricSnapshot(t, recorder, platformmetrics.WorkerOperationEchoRequirementDelivery, 2, 4*time.Hour)
	assertWorkerMetricSnapshot(t, recorder, platformmetrics.WorkerOperationEchoReleaseDelivery, 1, 2*time.Hour)
	assertWorkerMetricSnapshot(t, recorder, platformmetrics.WorkerOperationPresenceExpiry, 1, 90*time.Minute)
	assertWorkerMetricSnapshot(t, recorder, platformmetrics.WorkerOperationUploadStorageMaintenance, 1, files.DefaultStaleUploadAge)

	var emailStatus string
	var emailLease *time.Time
	if err := pool.QueryRow(ctx, `SELECT status, lease_until FROM workspace_email_jobs WHERE id = 'metrics-email-pending'`).Scan(&emailStatus, &emailLease); err != nil {
		t.Fatal(err)
	}
	if emailStatus != "pending" || emailLease != nil {
		t.Fatalf("collector mutated email queue status=%q lease=%v", emailStatus, emailLease)
	}
	var uploadStatus string
	if err := pool.QueryRow(ctx, `SELECT status FROM transfer_ledger WHERE id = 'metrics-upload'`).Scan(&uploadStatus); err != nil {
		t.Fatal(err)
	}
	if uploadStatus != "reserved" {
		t.Fatalf("collector mutated upload status=%q", uploadStatus)
	}
}

func seedWorkerMetricsFixture(t *testing.T, ctx context.Context, conn *pgx.Conn, now time.Time) {
	t.Helper()
	workerMetricsExec(t, ctx, conn, `INSERT INTO users (
 id, github_id, github_login, email, display_name, kind, created_at
) VALUES
 ('metrics-owner', 'metrics-owner-github', 'metrics-owner', 'metrics-owner@example.test', 'Metrics owner', 'human', $1),
 ('metrics-recipient', 'metrics-recipient-github', 'metrics-recipient', 'metrics-recipient@example.test', 'Metrics recipient', 'human', $1)`, now)
	workerMetricsExec(t, ctx, conn, `INSERT INTO spaces (id, name, slug, created_by, created_at)
 VALUES ('metrics-space', 'Synthetic metrics space', 'metrics-space', 'metrics-owner', $1)`, now)
	workerMetricsExec(t, ctx, conn, `INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES
 ('metrics-space', 'metrics-owner', 'owner', $1), ('metrics-space', 'metrics-recipient', 'member', $1)`, now)
	workerMetricsExec(t, ctx, conn, `INSERT INTO conversations (id, space_id, type, title, direct_key, created_by, created_at)
 VALUES ('metrics-conversation', 'metrics-space', 'direct', 'Synthetic metrics conversation', NULL, 'metrics-owner', $1)`, now)
	workerMetricsExec(t, ctx, conn, `INSERT INTO messages (
 id, space_id, conversation_id, author_id, author_kind, kind, client_message_id,
 content_format, content_json, plain_text, created_at
) VALUES
 ('metrics-message-1', 'metrics-space', 'metrics-conversation', 'metrics-owner', 'human', 'user', 'metrics-client-1', 'duallane.message+json;v=1', '{"blocks":[]}', 'synthetic', $1),
 ('metrics-message-2', 'metrics-space', 'metrics-conversation', 'metrics-owner', 'human', 'user', 'metrics-client-2', 'duallane.message+json;v=1', '{"blocks":[]}', 'synthetic', $1),
 ('metrics-message-3', 'metrics-space', 'metrics-conversation', 'metrics-owner', 'human', 'user', 'metrics-client-3', 'duallane.message+json;v=1', '{"blocks":[]}', 'synthetic', $1),
 ('metrics-message-4', 'metrics-space', 'metrics-conversation', 'metrics-owner', 'human', 'user', 'metrics-client-4', 'duallane.message+json;v=1', '{"blocks":[]}', 'synthetic', $1)`, now)

	workerMetricsExec(t, ctx, conn, `INSERT INTO workspace_email_jobs (
 id, user_id, message_id, conversation_id, event_seq, status, available_at,
 next_attempt_at, lease_until, attempt_count, created_at
) VALUES
 ('metrics-email-pending', 'metrics-recipient', 'metrics-message-1', 'metrics-conversation', 1, 'pending', $1::timestamptz - INTERVAL '4 hours', $1::timestamptz - INTERVAL '4 hours', NULL, 0, $1::timestamptz - INTERVAL '4 hours'),
 ('metrics-email-active', 'metrics-recipient', 'metrics-message-2', 'metrics-conversation', 2, 'sending', $1::timestamptz - INTERVAL '90 minutes', $1::timestamptz - INTERVAL '90 minutes', $1::timestamptz + INTERVAL '20 minutes', 1, $1::timestamptz - INTERVAL '80 minutes')`, now)
	workerMetricsExec(t, ctx, conn, `INSERT INTO workspace_email_digest_states (
 user_id, started_at, notified_at, lease_until, attempt_count, next_attempt_at, updated_at
) VALUES ('metrics-owner', $1::timestamptz - INTERVAL '5 hours', NULL, NULL, 0, $1::timestamptz - INTERVAL '5 hours', $1::timestamptz - INTERVAL '5 hours')`, now)
	workerMetricsExec(t, ctx, conn, `INSERT INTO workspace_ntfy_jobs (
 id, user_id, message_id, conversation_id, event_seq, status, available_at,
 next_attempt_at, lease_until, attempt_count, created_at
) VALUES
 ('metrics-ntfy-expired', 'metrics-recipient', 'metrics-message-3', 'metrics-conversation', 3, 'sending', $1::timestamptz - INTERVAL '90 minutes', $1::timestamptz - INTERVAL '90 minutes', $1::timestamptz - INTERVAL '10 minutes', 1, $1::timestamptz - INTERVAL '90 minutes'),
 ('metrics-ntfy-active', 'metrics-recipient', 'metrics-message-4', 'metrics-conversation', 4, 'sending', $1::timestamptz - INTERVAL '70 minutes', $1::timestamptz - INTERVAL '70 minutes', $1::timestamptz + INTERVAL '20 minutes', 1, $1::timestamptz - INTERVAL '70 minutes')`, now)

	workerMetricsExec(t, ctx, conn, `INSERT INTO echo_requirements (
 id, public_id, space_id, submitter_user_id, type, title, detail, scenario,
 expected_result, state, phase, status, revision, created_at, updated_at
) VALUES ('metrics-requirement', 'REQ-2026-0001', 'metrics-space', 'metrics-recipient',
 'requirement', 'Synthetic requirement', 'Synthetic detail', 'Synthetic scenario',
 'Synthetic result', 'submitted', 'proposal', 'pending_review', 1,
 $1::timestamptz - INTERVAL '3 hours', $1::timestamptz - INTERVAL '2 hours')`, now)
	workerMetricsExec(t, ctx, conn, `INSERT INTO echo_requirements (
 id, public_id, space_id, submitter_user_id, type, title, detail, scenario,
 expected_result, state, phase, status, revision, created_at, updated_at
) VALUES ('metrics-requirement-archived', 'REQ-2026-0002', 'metrics-space', 'metrics-recipient',
 'requirement', 'Synthetic archived requirement', 'Synthetic detail', 'Synthetic scenario',
 'Synthetic result', 'rejected', 'archived', 'archived', 1,
 $1::timestamptz - INTERVAL '5 hours', $1::timestamptz - INTERVAL '4 hours')`, now)
	workerMetricsExec(t, ctx, conn, `INSERT INTO echo_solicitations (
 id, public_id, space_id, owner_user_id, title, description, question,
 choice_mode, min_selections, max_selections, allow_vote_change,
 result_visibility, delivery_policy, status, revision, created_at, updated_at, published_at
) VALUES
 ('metrics-solicitation-pending', 'SOL-2026-0001', 'metrics-space', 'metrics-owner', 'Synthetic pending', 'Synthetic', 'Synthetic?', 'single', 1, 1, TRUE, 'aggregate', 'all_active_members', 'open', 1, $1::timestamptz - INTERVAL '3 hours', $1::timestamptz - INTERVAL '3 hours', $1::timestamptz - INTERVAL '3 hours'),
 ('metrics-solicitation-failed', 'SOL-2026-0002', 'metrics-space', 'metrics-owner', 'Synthetic failed', 'Synthetic', 'Synthetic?', 'single', 1, 1, TRUE, 'aggregate', 'all_active_members', 'open', 1, $1::timestamptz - INTERVAL '2 hours', $1::timestamptz - INTERVAL '2 hours', $1::timestamptz - INTERVAL '2 hours')`, now)
	workerMetricsExec(t, ctx, conn, `INSERT INTO echo_solicitation_deliveries (
 id, space_id, solicitation_id, recipient_user_id, status, attempt_count, created_at, updated_at
) VALUES
 ('metrics-solicitation-delivery-1', 'metrics-space', 'metrics-solicitation-pending', 'metrics-recipient', 'pending', 0, $1::timestamptz - INTERVAL '3 hours', $1::timestamptz - INTERVAL '3 hours'),
 ('metrics-solicitation-delivery-2', 'metrics-space', 'metrics-solicitation-failed', 'metrics-recipient', 'failed', 1, $1::timestamptz - INTERVAL '2 hours', $1::timestamptz - INTERVAL '2 hours')`, now)
	workerMetricsExec(t, ctx, conn, `INSERT INTO echo_release_publications (
 id, space_id, version, title, guide_hash, guide_json, published_by_user_id, published_at
) VALUES ('metrics-publication', 'metrics-space', '0.16.0', 'Synthetic release', repeat('a', 64), '{}', 'metrics-owner', $1::timestamptz - INTERVAL '2 hours')`, now)
	workerMetricsExec(t, ctx, conn, `INSERT INTO echo_release_deliveries (
 id, space_id, publication_id, recipient_user_id, status, attempt_count, created_at, updated_at
) VALUES ('metrics-release-delivery', 'metrics-space', 'metrics-publication', 'metrics-recipient', 'pending', 0, $1::timestamptz - INTERVAL '2 hours', $1::timestamptz - INTERVAL '2 hours')`, now)
	workerMetricsExec(t, ctx, conn, `INSERT INTO workspace_presence_leases (
 space_id, user_id, connection_id, lease_until, created_at, updated_at
) VALUES ('metrics-space', 'metrics-recipient', 'metrics-expired-connection', $1::timestamptz - INTERVAL '90 minutes', $1::timestamptz - INTERVAL '2 hours', $1::timestamptz - INTERVAL '90 minutes')`, now)
	workerMetricsExec(t, ctx, conn, `INSERT INTO attachments (
 id, space_id, uploader_id, visibility, status, file_name, mime_type, byte_size,
 storage_key, upload_transfer_id, created_at
) VALUES ('metrics-attachment', 'metrics-space', 'metrics-owner', 'private_staging', 'pending',
 'synthetic.txt', 'text/plain', 7, NULL, 'metrics-upload', $1::timestamptz - INTERVAL '6 hours')`, now)
	workerMetricsExec(t, ctx, conn, `INSERT INTO transfer_ledger (
 id, space_id, user_id, direction, byte_size, status, attachment_id, created_at, last_activity_at
) VALUES ('metrics-upload', 'metrics-space', 'metrics-owner', 'upload', 7, 'reserved', 'metrics-attachment',
 $1::timestamptz - INTERVAL '6 hours', $1::timestamptz - INTERVAL '6 hours')`, now)
}

func workerMetricsExec(t *testing.T, ctx context.Context, conn *pgx.Conn, query string, args ...any) {
	t.Helper()
	if _, err := conn.Exec(ctx, query, args...); err != nil {
		t.Fatal(err)
	}
}

func assertWorkerMetricSnapshot(t *testing.T, recorder *workerBacklogRecorderSpy, operation platformmetrics.WorkerOperation, pending int64, minAge time.Duration) {
	t.Helper()
	snapshot, ok := recorder.snapshots[operation]
	if !ok {
		t.Fatalf("missing worker metric operation %q", operation)
	}
	if snapshot.Pending != pending {
		t.Fatalf("%s pending=%d want=%d", operation, snapshot.Pending, pending)
	}
	if snapshot.OldestAge < minAge {
		t.Fatalf("%s oldest age=%s want at least %s", operation, snapshot.OldestAge, minAge)
	}
	if snapshot.OldestLeaseAge != 0 {
		t.Fatalf("%s oldest lease age=%s want zero without acquired-at data", operation, snapshot.OldestLeaseAge)
	}
}
