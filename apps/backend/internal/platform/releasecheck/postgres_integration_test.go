//go:build postgres_integration

package releasecheck

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	platformmigrations "github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	platformpostgres "github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
)

func TestCheckPostgresReportsDurableDrainStateWithoutMutatingIt(t *testing.T) {
	fixture := newReleaseCheckFixture(t, true)
	now := time.Now().UTC()
	seedBaseRows(t, fixture, now)
	seedMixedDrainRows(t, fixture, now)

	report, err := Check(fixture.ctx, fixture.pool)
	if err != nil {
		t.Fatalf("Check() error = %v", err)
	}
	if report.Ready {
		t.Fatal("observed durable blockers were reported ready")
	}
	if !report.ReadOnly || report.SnapshotAt.IsZero() {
		t.Fatalf("snapshot metadata = %#v", report)
	}
	if report.Writers.Status != ObservationNotProven || report.Provider.Status != ObservationNotChecked {
		t.Fatalf("external coverage was overstated: writers=%#v provider=%#v", report.Writers, report.Provider)
	}

	if got := report.Counts.Uploads; got.Reserved != 4 || got.StaleReserved != 2 || got.MissingAttachment != 1 || got.NonPendingAttachment != 1 || got.PartRows != 2 || got.PartUploadCount != 2 || got.ReservedPartRows != 2 {
		t.Fatalf("upload counts = %#v", got)
	}
	if got := report.Counts.EmailJobs; got.Pending != 1 || got.Sending != 3 || got.Sent != 1 || got.Failed != 1 || got.ActiveLeases != 2 || got.ExpiredLeases != 1 || got.SendingMissingLease != 1 || got.SendingExpiredLease != 1 || got.LeaseAnomalies != 1 {
		t.Fatalf("email counts = %#v", got)
	}
	if got := report.Counts.NtfyJobs; got.Pending != 1 || got.Sending != 2 || got.ActiveLeases != 0 || got.ExpiredLeases != 1 || got.SendingMissingLease != 1 || got.SendingExpiredLease != 1 {
		t.Fatalf("ntfy counts = %#v", got)
	}
	if got := report.Counts.EmailDigest; got.Rows != 3 || got.Unnotified != 2 || got.Notified != 1 || got.ActiveLeases != 2 || got.ExpiredLeases != 1 || got.UnnotifiedActiveLeases != 1 || got.UnnotifiedExpiredLeases != 1 || got.UnnotifiedWithoutLease != 0 || got.NotifiedWithLease != 1 {
		t.Fatalf("digest counts = %#v", got)
	}
	if got := report.Counts.EchoSolicitation; got.Pending != 1 || got.Sent != 1 || got.Failed != 1 || got.Reconcile != 1 {
		t.Fatalf("echo solicitation counts = %#v", got)
	}
	if got := report.Counts.EchoRelease; got.Pending != 1 || got.Sent != 1 || got.Failed != 1 || got.Reconcile != 0 {
		t.Fatalf("echo release counts = %#v", got)
	}

	for _, code := range []string{
		BlockerUploadReserved,
		BlockerUploadMissingAttachment,
		BlockerUploadNonPending,
		BlockerEmailSending,
		BlockerEmailLeaseAnomaly,
		BlockerNtfySending,
		BlockerDigestActiveLease,
		BlockerDigestLeaseAnomaly,
	} {
		if blockerCount(report, code) == 0 {
			t.Fatalf("missing blocker %q: %#v", code, report.Blockers)
		}
	}
	if blockerCount(report, BlockerSnapshotFailed) != 0 {
		t.Fatalf("snapshot unexpectedly failed: %#v", report.Blockers)
	}

	var transferStatus, attachmentStatus string
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT tl.status, a.status
FROM transfer_ledger AS tl
JOIN attachments AS a ON a.upload_transfer_id = tl.id
WHERE tl.id = 'upload-stale'`).Scan(&transferStatus, &attachmentStatus); err != nil {
		t.Fatal(err)
	}
	if transferStatus != "reserved" || attachmentStatus != "pending" {
		t.Fatalf("Check mutated stale upload: transfer=%q attachment=%q", transferStatus, attachmentStatus)
	}
}

func TestCheckPostgresAllowsQueuedAndEchoObservations(t *testing.T) {
	fixture := newReleaseCheckFixture(t, true)
	now := time.Now().UTC()
	seedBaseRows(t, fixture, now)
	seedQueuedRows(t, fixture, now)

	report, err := Check(fixture.ctx, fixture.pool)
	if err != nil {
		t.Fatalf("Check() error = %v", err)
	}
	if !report.Ready {
		t.Fatalf("queued/reconciliation rows unexpectedly blocked: %#v", report.Blockers)
	}
	if report.Counts.EmailJobs.Pending != 1 || report.Counts.NtfyJobs.Pending != 1 {
		t.Fatalf("queued jobs were not retained in counts: email=%#v ntfy=%#v", report.Counts.EmailJobs, report.Counts.NtfyJobs)
	}
	if report.Counts.EmailDigest.UnnotifiedWithoutLease != 1 {
		t.Fatalf("queued digest state = %#v", report.Counts.EmailDigest)
	}
	if report.Counts.EchoSolicitation.Pending != 1 || report.Counts.EchoSolicitation.Failed != 1 || report.Counts.EchoSolicitation.Reconcile != 1 {
		t.Fatalf("echo observations = %#v", report.Counts.EchoSolicitation)
	}
	if report.Counts.EchoRelease.Pending != 1 || report.Counts.EchoRelease.Failed != 1 {
		t.Fatalf("echo release observations = %#v", report.Counts.EchoRelease)
	}
}

func TestCheckPostgresFailsClosedOnIncompleteSchema(t *testing.T) {
	fixture := newReleaseCheckFixture(t, false)
	report, err := Check(fixture.ctx, fixture.pool)
	if err != nil {
		t.Fatalf("incomplete schema should be a report, not an unclassified error: %v", err)
	}
	if report.Ready || report.Counts.Schema.MissingItems == 0 || blockerCount(report, BlockerSchemaIncompatible) == 0 {
		t.Fatalf("incomplete schema was not fail-closed: %#v", report)
	}
}

func TestCheckPostgresCountsNullableAndUnknownStatusesAsUnsafe(t *testing.T) {
	fixture := newReleaseCheckFixture(t, false)
	createNullableReleaseCheckSchema(t, fixture)
	now := time.Now().UTC()
	mustExecReleaseCheck(t, fixture, `INSERT INTO transfer_ledger (id, direction, status, created_at)
VALUES ('transfer-null', 'upload', NULL, $1), ('transfer-unknown', 'upload', 'garbage', $1)`, now)
	mustExecReleaseCheck(t, fixture, `INSERT INTO workspace_email_jobs (status) VALUES (NULL), ('garbage')`)
	mustExecReleaseCheck(t, fixture, `INSERT INTO workspace_ntfy_jobs (status) VALUES (NULL)`)
	mustExecReleaseCheck(t, fixture, `INSERT INTO echo_solicitation_deliveries (status) VALUES (NULL)`)
	mustExecReleaseCheck(t, fixture, `INSERT INTO echo_release_deliveries (status) VALUES ('garbage')`)

	report, err := Check(fixture.ctx, fixture.pool)
	if err != nil {
		t.Fatalf("Check() error = %v", err)
	}
	if report.Ready {
		t.Fatal("nullable/unknown statuses were reported ready")
	}
	if report.Counts.Schema.MissingItems != 0 {
		t.Fatalf("test schema was considered incomplete: %#v", report.Counts.Schema)
	}
	if report.Counts.Uploads.UnknownStatus != 2 || blockerCount(report, BlockerUploadUnknownStatus) != 2 {
		t.Fatalf("upload unknown statuses = %#v, blockers=%#v", report.Counts.Uploads, report.Blockers)
	}
	if report.Counts.EmailJobs.UnknownStatus != 2 || blockerCount(report, BlockerEmailUnknownStatus) != 2 {
		t.Fatalf("email unknown statuses = %#v, blockers=%#v", report.Counts.EmailJobs, report.Blockers)
	}
	if report.Counts.NtfyJobs.UnknownStatus != 1 || blockerCount(report, BlockerNtfyUnknownStatus) != 1 {
		t.Fatalf("ntfy unknown statuses = %#v, blockers=%#v", report.Counts.NtfyJobs, report.Blockers)
	}
	if report.Counts.EchoSolicitation.UnknownStatus != 1 || blockerCount(report, BlockerEchoSolicitationUnknown) != 1 {
		t.Fatalf("echo solicitation unknown statuses = %#v, blockers=%#v", report.Counts.EchoSolicitation, report.Blockers)
	}
	if report.Counts.EchoRelease.UnknownStatus != 1 || blockerCount(report, BlockerEchoReleaseUnknown) != 1 {
		t.Fatalf("echo release unknown statuses = %#v, blockers=%#v", report.Counts.EchoRelease, report.Blockers)
	}
}

func TestCheckPostgresFailsClosedAndBoundedByLockedRelation(t *testing.T) {
	fixture := newReleaseCheckFixture(t, true)
	holdTransferTableLock(t, fixture)

	started := time.Now()
	report, err := Check(fixture.ctx, fixture.pool)
	elapsed := time.Since(started)
	if err == nil || !errors.Is(err, ErrCheckFailed) {
		t.Fatalf("locked snapshot error = %v, want generic ErrCheckFailed", err)
	}
	if report.Ready || blockerCount(report, BlockerSnapshotFailed) != 1 {
		t.Fatalf("locked snapshot was not fail-closed: %#v", report)
	}
	if elapsed > 3*time.Second {
		t.Fatalf("locked snapshot exceeded bounded deadline: %s", elapsed)
	}
	if strings.Contains(err.Error(), "transfer_ledger") || strings.Contains(err.Error(), "ACCESS EXCLUSIVE") || strings.Contains(err.Error(), "SELECT") {
		t.Fatalf("locked snapshot exposed raw SQL details: %q", err)
	}

	shortCtx, cancel := context.WithTimeout(fixture.ctx, 100*time.Millisecond)
	defer cancel()
	started = time.Now()
	report, err = Check(shortCtx, fixture.pool)
	elapsed = time.Since(started)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("short locked snapshot error = %v, want context deadline", err)
	}
	if report.Ready || blockerCount(report, BlockerSnapshotFailed) != 1 {
		t.Fatalf("short locked snapshot was not fail-closed: %#v", report)
	}
	if elapsed > time.Second {
		t.Fatalf("outer context bound was not respected: %s", elapsed)
	}
	if strings.Contains(err.Error(), "transfer_ledger") || strings.Contains(err.Error(), "SELECT") {
		t.Fatalf("short locked snapshot exposed raw SQL details: %q", err)
	}
}

type releaseCheckFixture struct {
	ctx    context.Context
	conn   *pgx.Conn
	pool   *pgxpool.Pool
	schema string
}

func newReleaseCheckFixture(t *testing.T, applyMigrations bool) *releaseCheckFixture {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := conn.Close(context.Background()); err != nil {
			t.Errorf("close isolated releasecheck connection: %v", err)
		}
	})
	schema := fmt.Sprintf("duallane_releasecheck_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := conn.Exec(cleanupCtx, "DROP SCHEMA IF EXISTS "+identifier+" CASCADE"); err != nil {
			t.Errorf("drop isolated releasecheck schema: %v", err)
		}
	})
	if _, err := conn.Exec(ctx, "SET search_path TO "+identifier); err != nil {
		t.Fatal(err)
	}
	if applyMigrations {
		_, sourceFile, _, ok := runtime.Caller(0)
		if !ok {
			t.Fatal("runtime.Caller failed")
		}
		migrationDirectory := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../web/server/migrations"))
		if _, err := (platformmigrations.Runner{
			Beginner:  platformpostgres.NewMigrationBeginner(conn),
			Directory: migrationDirectory,
		}).Run(ctx); err != nil {
			t.Fatal(err)
		}
	}

	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 2
	config.MinConns = 0
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
	})
	if err := pool.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	fixture := &releaseCheckFixture{ctx: ctx, conn: conn, pool: pool, schema: schema}
	return fixture
}

func holdTransferTableLock(t *testing.T, fixture *releaseCheckFixture) {
	t.Helper()
	if _, err := fixture.conn.Exec(fixture.ctx, `BEGIN`); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.conn.Exec(fixture.ctx, `LOCK TABLE transfer_ledger IN ACCESS EXCLUSIVE MODE`); err != nil {
		_, _ = fixture.conn.Exec(context.Background(), `ROLLBACK`)
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := fixture.conn.Exec(context.Background(), `ROLLBACK`); err != nil {
			t.Errorf("release isolated transfer lock: %v", err)
		}
	})
}

func seedBaseRows(t *testing.T, fixture *releaseCheckFixture, now time.Time) {
	t.Helper()
	for _, user := range []struct {
		id, login, name string
	}{
		{"usr_release_owner", "release-owner", "Owner"},
		{"usr_release_member", "release-member", "Member"},
		{"usr_release_other", "release-other", "Other"},
		{"usr_release_third", "release-third", "Third"},
	} {
		mustExecReleaseCheck(t, fixture, `INSERT INTO users (id, github_login, display_name, kind, created_at)
VALUES ($1, $2, $3, 'human', $4)`, user.id, user.login, user.name, now)
	}
	mustExecReleaseCheck(t, fixture, `INSERT INTO spaces (id, name, slug, created_by, created_at)
VALUES ('spc_releasecheck', 'Release check', 'release-check', 'usr_release_owner', $1)`, now)
	mustExecReleaseCheck(t, fixture, `INSERT INTO space_members (space_id, user_id, role, joined_at)
VALUES ('spc_releasecheck', 'usr_release_owner', 'owner', $1),
       ('spc_releasecheck', 'usr_release_member', 'member', $1),
       ('spc_releasecheck', 'usr_release_other', 'member', $1),
       ('spc_releasecheck', 'usr_release_third', 'member', $1)`, now)
	mustExecReleaseCheck(t, fixture, `INSERT INTO conversations (id, space_id, type, title, created_by, created_at)
VALUES ('conv_releasecheck', 'spc_releasecheck', 'group', 'Release check', 'usr_release_owner', $1)`, now)
}

func createNullableReleaseCheckSchema(t *testing.T, fixture *releaseCheckFixture) {
	t.Helper()
	for _, query := range []string{
		`CREATE TABLE attachments (id TEXT, upload_transfer_id TEXT, status TEXT)`,
		`CREATE TABLE transfer_ledger (id TEXT, direction TEXT, status TEXT, last_activity_at TIMESTAMPTZ, created_at TIMESTAMPTZ)`,
		`CREATE TABLE workspace_upload_parts (upload_id TEXT)`,
		`CREATE TABLE workspace_email_jobs (status TEXT, next_attempt_at TIMESTAMPTZ, lease_until TIMESTAMPTZ)`,
		`CREATE TABLE workspace_ntfy_jobs (status TEXT, next_attempt_at TIMESTAMPTZ, lease_until TIMESTAMPTZ)`,
		`CREATE TABLE workspace_email_digest_states (notified_at TIMESTAMPTZ, lease_until TIMESTAMPTZ)`,
		`CREATE TABLE echo_solicitation_deliveries (status TEXT, solicitation_id TEXT)`,
		`CREATE TABLE echo_solicitations (id TEXT, status TEXT)`,
		`CREATE TABLE echo_release_deliveries (status TEXT)`,
	} {
		mustExecReleaseCheck(t, fixture, query)
	}
}

func seedMixedDrainRows(t *testing.T, fixture *releaseCheckFixture, now time.Time) {
	t.Helper()
	old := now.Add(-time.Hour)
	seedAttachment(t, fixture, "att-upload-stale", "upload-stale", "pending", old)
	seedAttachment(t, fixture, "att-upload-recent", "upload-recent", "pending", now)
	seedAttachment(t, fixture, "att-upload-nonpending", "upload-nonpending", "available", now)
	seedTransfer(t, fixture, "upload-missing", "", old, nil)
	seedTransfer(t, fixture, "upload-stale", "att-upload-stale", old, &old)
	seedTransfer(t, fixture, "upload-recent", "att-upload-recent", now, &now)
	seedTransfer(t, fixture, "upload-nonpending", "att-upload-nonpending", now, &now)
	seedPart(t, fixture, "upload-stale", 1, old)
	seedPart(t, fixture, "upload-missing", 1, old)

	insertJobMessage(t, fixture, "email-pending-message", now)
	insertJobMessage(t, fixture, "email-sending-active-message", now)
	insertJobMessage(t, fixture, "email-sending-expired-message", now)
	insertJobMessage(t, fixture, "email-sending-missing-message", now)
	insertJobMessage(t, fixture, "email-sent-message", now)
	insertJobMessage(t, fixture, "email-failed-message", now)
	insertJobMessage(t, fixture, "ntfy-pending-message", now)
	insertJobMessage(t, fixture, "ntfy-sending-expired-message", now)
	insertJobMessage(t, fixture, "ntfy-sending-missing-message", now)
	insertJobMessage(t, fixture, "digest-active-message", now)
	insertJobMessage(t, fixture, "digest-expired-message", now)
	insertJobMessage(t, fixture, "digest-notified-message", now)

	mustExecReleaseCheck(t, fixture, `INSERT INTO workspace_email_jobs
(id, user_id, message_id, conversation_id, event_seq, status, available_at, next_attempt_at, lease_until, attempt_count, created_at)
VALUES
('email-pending', 'usr_release_owner', 'email-pending-message', 'conv_releasecheck', 1, 'pending', $1, $1, NULL, 0, $1),
('email-sending-active', 'usr_release_owner', 'email-sending-active-message', 'conv_releasecheck', 2, 'sending', $1, $1, $2, 1, $1),
('email-sending-expired', 'usr_release_owner', 'email-sending-expired-message', 'conv_releasecheck', 3, 'sending', $1, $1, $3, 1, $1),
('email-sending-missing', 'usr_release_owner', 'email-sending-missing-message', 'conv_releasecheck', 4, 'sending', $1, $1, NULL, 1, $1),
('email-sent', 'usr_release_owner', 'email-sent-message', 'conv_releasecheck', 5, 'sent', $1, $1, $2, 1, $1),
('email-failed', 'usr_release_owner', 'email-failed-message', 'conv_releasecheck', 6, 'failed', $1, $1, NULL, 3, $1)`, now, now.Add(time.Minute), now.Add(-time.Minute))
	mustExecReleaseCheck(t, fixture, `INSERT INTO workspace_ntfy_jobs
(id, user_id, message_id, conversation_id, event_seq, status, available_at, next_attempt_at, lease_until, attempt_count, created_at)
VALUES
('ntfy-pending', 'usr_release_owner', 'ntfy-pending-message', 'conv_releasecheck', 1, 'pending', $1, $1, NULL, 0, $1),
('ntfy-sending-expired', 'usr_release_owner', 'ntfy-sending-expired-message', 'conv_releasecheck', 2, 'sending', $1, $1, $2, 1, $1),
('ntfy-sending-missing', 'usr_release_owner', 'ntfy-sending-missing-message', 'conv_releasecheck', 3, 'sending', $1, $1, NULL, 1, $1)`, now, now.Add(-time.Minute))
	mustExecReleaseCheck(t, fixture, `INSERT INTO workspace_email_digest_states
(user_id, started_at, notified_at, lease_until, attempt_count, next_attempt_at, updated_at)
VALUES
('usr_release_owner', $1, NULL, $2, 1, $1, $1),
('usr_release_member', $1, NULL, $3, 1, $1, $1),
('usr_release_other', $1, $4, $2, 1, $1, $1)`, now, now.Add(time.Minute), now.Add(-time.Minute), now)

	seedEchoRows(t, fixture, now)
}

func seedQueuedRows(t *testing.T, fixture *releaseCheckFixture, now time.Time) {
	t.Helper()
	insertJobMessage(t, fixture, "queued-email-message", now)
	insertJobMessage(t, fixture, "queued-ntfy-message", now)
	insertJobMessage(t, fixture, "queued-digest-message", now)
	mustExecReleaseCheck(t, fixture, `INSERT INTO workspace_email_jobs
(id, user_id, message_id, conversation_id, event_seq, status, available_at, next_attempt_at, lease_until, attempt_count, created_at)
VALUES ('queued-email', 'usr_release_owner', 'queued-email-message', 'conv_releasecheck', 1, 'pending', $1, $2, NULL, 0, $1)`, now, now.Add(time.Hour))
	mustExecReleaseCheck(t, fixture, `INSERT INTO workspace_ntfy_jobs
(id, user_id, message_id, conversation_id, event_seq, status, available_at, next_attempt_at, lease_until, attempt_count, created_at)
VALUES ('queued-ntfy', 'usr_release_owner', 'queued-ntfy-message', 'conv_releasecheck', 1, 'pending', $1, $2, NULL, 0, $1)`, now, now.Add(time.Hour))
	mustExecReleaseCheck(t, fixture, `INSERT INTO workspace_email_digest_states
(user_id, started_at, notified_at, lease_until, attempt_count, next_attempt_at, updated_at)
VALUES ('usr_release_owner', $1, NULL, NULL, 0, $2, $1)`, now, now.Add(time.Hour))
	seedEchoRows(t, fixture, now)
}

func seedAttachment(t *testing.T, fixture *releaseCheckFixture, attachmentID, transferID, status string, createdAt time.Time) {
	mustExecReleaseCheck(t, fixture, `INSERT INTO attachments
(id, space_id, uploader_id, conversation_id, visibility, status, file_name, mime_type, byte_size, upload_transfer_id, created_at)
VALUES ($1, 'spc_releasecheck', 'usr_release_owner', 'conv_releasecheck', 'private_staging', $3, 'fixture.txt', 'text/plain', 4, $2, $4)`, attachmentID, transferID, status, createdAt)
}

func seedTransfer(t *testing.T, fixture *releaseCheckFixture, transferID, attachmentID string, createdAt time.Time, lastActivity *time.Time) {
	mustExecReleaseCheck(t, fixture, `INSERT INTO transfer_ledger
(id, space_id, user_id, direction, byte_size, status, attachment_id, created_at, last_activity_at)
VALUES ($1, 'spc_releasecheck', 'usr_release_owner', 'upload', 4, 'reserved', $2, $3, $4)`, transferID, nullableString(attachmentID), createdAt, lastActivity)
}

func seedPart(t *testing.T, fixture *releaseCheckFixture, uploadID string, partNumber int, at time.Time) {
	mustExecReleaseCheck(t, fixture, `INSERT INTO workspace_upload_parts
(upload_id, part_number, byte_size, sha256, created_at, updated_at)
VALUES ($1, $2, 4, $3, $4, $4)`, uploadID, partNumber, strings.Repeat("a", 64), at)
}

func insertJobMessage(t *testing.T, fixture *releaseCheckFixture, messageID string, now time.Time) {
	mustExecReleaseCheck(t, fixture, `INSERT INTO messages
(id, space_id, conversation_id, author_id, author_kind, kind, content_format, content_json, plain_text, created_at)
VALUES ($1, 'spc_releasecheck', 'conv_releasecheck', 'usr_release_owner', 'human', 'user', 'text', '{}', 'fixture', $2)`, messageID, now)
}

func seedEchoRows(t *testing.T, fixture *releaseCheckFixture, now time.Time) {
	t.Helper()
	mustExecReleaseCheck(t, fixture, `INSERT INTO echo_solicitations
(id, public_id, space_id, owner_user_id, title, description, question, choice_mode, min_selections, max_selections, allow_vote_change, result_visibility, delivery_policy, status, revision, created_at, updated_at)
VALUES ('sol-releasecheck', 'sol-releasecheck-public', 'spc_releasecheck', 'usr_release_owner', 'Synthetic', 'Synthetic', 'Synthetic?', 'single', 1, 1, TRUE, 'aggregate', 'all_active_members', 'open', 1, $1, $1)`, now)
	mustExecReleaseCheck(t, fixture, `INSERT INTO echo_solicitation_deliveries
(id, space_id, solicitation_id, recipient_user_id, status, attempt_count, created_at, updated_at)
VALUES
('sol-delivery-pending', 'spc_releasecheck', 'sol-releasecheck', 'usr_release_owner', 'pending', 0, $1, $1),
('sol-delivery-failed', 'spc_releasecheck', 'sol-releasecheck', 'usr_release_member', 'failed', 1, $1, $1),
('sol-delivery-sent', 'spc_releasecheck', 'sol-releasecheck', 'usr_release_other', 'sent', 1, $1, $1)`, now)
	mustExecReleaseCheck(t, fixture, `INSERT INTO echo_release_publications
(id, space_id, version, title, guide_hash, guide_json, published_by_user_id, published_at)
VALUES ('release-publication', 'spc_releasecheck', 'v1', 'Synthetic', $1, '{}', 'usr_release_owner', $2)`, strings.Repeat("b", 64), now)
	mustExecReleaseCheck(t, fixture, `INSERT INTO echo_release_deliveries
(id, space_id, publication_id, recipient_user_id, status, attempt_count, created_at, updated_at)
VALUES
('release-delivery-pending', 'spc_releasecheck', 'release-publication', 'usr_release_owner', 'pending', 0, $1, $1),
('release-delivery-failed', 'spc_releasecheck', 'release-publication', 'usr_release_member', 'failed', 1, $1, $1),
('release-delivery-sent', 'spc_releasecheck', 'release-publication', 'usr_release_other', 'sent', 1, $1, $1)`, now)
}

func mustExecReleaseCheck(t *testing.T, fixture *releaseCheckFixture, query string, args ...any) {
	t.Helper()
	if _, err := fixture.conn.Exec(fixture.ctx, query, args...); err != nil {
		t.Fatal(err)
	}
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}
