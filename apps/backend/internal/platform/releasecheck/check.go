package releasecheck

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalidInput = errors.New("release check input is invalid")
	ErrCheckFailed  = errors.New("release check failed")
)

// Check reads one repeatable-read, read-only PostgreSQL snapshot. It never
// calls a domain service, changes a row, claims a lease, or touches object
// storage. A nil error with Ready=false is a valid fail-closed observation
// such as an incompatible schema or an observed drain blocker. Ready does not
// prove that writers are fenced or that provider-side work is quiescent.
func Check(ctx context.Context, pool *pgxpool.Pool) (Report, error) {
	report := newReport()
	if ctx == nil {
		return checkFailure(report, BlockerSnapshotFailed, ErrInvalidInput)
	}
	if pool == nil {
		return checkFailure(report, BlockerSnapshotFailed, ErrInvalidInput)
	}
	if err := ctx.Err(); err != nil {
		return checkFailure(report, BlockerSnapshotFailed, err)
	}

	checkCtx, cancel := context.WithTimeout(ctx, DefaultCheckTimeout)
	defer cancel()
	tx, err := pool.BeginTx(checkCtx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return checkFailure(report, BlockerSnapshotFailed, err)
	}
	defer rollbackReadOnly(tx)

	if _, err := tx.Exec(checkCtx, `SET LOCAL statement_timeout = '500ms'`); err != nil {
		return checkFailure(report, BlockerSnapshotFailed, err)
	}

	missing, err := readMissingSchema(checkCtx, tx)
	if err != nil {
		return checkFailure(report, BlockerSchemaUnavailable, err)
	}
	report.Counts.Schema.MissingItems = missing
	if missing > 0 {
		addBlocker(&report, BlockerSchemaIncompatible, missing)
		return report, nil
	}

	if err := tx.QueryRow(checkCtx, `SELECT CURRENT_TIMESTAMP`).Scan(&report.SnapshotAt); err != nil {
		return checkFailure(report, BlockerSnapshotFailed, err)
	}
	if err := readUploadCounts(checkCtx, tx, report.SnapshotAt, &report.Counts.Uploads); err != nil {
		return checkFailure(report, BlockerSnapshotFailed, err)
	}
	if err := readJobCounts(checkCtx, tx, emailJobCountsSQL, report.SnapshotAt, &report.Counts.EmailJobs); err != nil {
		return checkFailure(report, BlockerSnapshotFailed, err)
	}
	if err := readJobCounts(checkCtx, tx, ntfyJobCountsSQL, report.SnapshotAt, &report.Counts.NtfyJobs); err != nil {
		return checkFailure(report, BlockerSnapshotFailed, err)
	}
	if err := readDigestCounts(checkCtx, tx, report.SnapshotAt, &report.Counts.EmailDigest); err != nil {
		return checkFailure(report, BlockerSnapshotFailed, err)
	}
	if err := readEchoSolicitationCounts(checkCtx, tx, &report.Counts.EchoSolicitation); err != nil {
		return checkFailure(report, BlockerSnapshotFailed, err)
	}
	if err := readEchoReleaseCounts(checkCtx, tx, &report.Counts.EchoRelease); err != nil {
		return checkFailure(report, BlockerSnapshotFailed, err)
	}

	// PostgreSQL metadata visibility is not a complete writer-fence proof:
	// pg_stat_activity and pg_locks can omit other users, containers, or a
	// writer that reconnects after this snapshot. Keep this explicit rather
	// than manufacturing a false "no writers" result.
	report.Writers = WriterObservation{
		Status:     ObservationNotProven,
		ReasonCode: "complete_writer_view_unsupported",
	}
	report.Provider = ProviderObservation{
		Status:     ObservationNotChecked,
		ReasonCode: "provider_state_outside_postgresql",
	}
	finalize(&report)
	return report, nil
}

func newReport() Report {
	return Report{
		ReadOnly: true,
		Blockers: make([]Blocker, 0),
		Writers: WriterObservation{
			Status:     ObservationNotProven,
			ReasonCode: "complete_writer_view_unsupported",
		},
		Provider: ProviderObservation{
			Status:     ObservationNotChecked,
			ReasonCode: "provider_state_outside_postgresql",
		},
	}
}

func finalize(report *Report) {
	if report == nil {
		return
	}
	addBlocker(report, BlockerUploadUnknownStatus, report.Counts.Uploads.UnknownStatus)
	addBlocker(report, BlockerUploadReserved, report.Counts.Uploads.Reserved)
	addBlocker(report, BlockerUploadMissingAttachment, report.Counts.Uploads.MissingAttachment)
	addBlocker(report, BlockerUploadNonPending, report.Counts.Uploads.NonPendingAttachment)

	addJobBlockers(report, report.Counts.EmailJobs, BlockerEmailUnknownStatus, BlockerEmailSending, BlockerEmailLeaseAnomaly)
	addJobBlockers(report, report.Counts.NtfyJobs, BlockerNtfyUnknownStatus, BlockerNtfySending, BlockerNtfyLeaseAnomaly)
	addBlocker(report, BlockerDigestActiveLease, report.Counts.EmailDigest.UnnotifiedActiveLeases)
	addBlocker(report, BlockerDigestLeaseAnomaly, report.Counts.EmailDigest.NotifiedWithLease)
	addBlocker(report, BlockerEchoSolicitationUnknown, report.Counts.EchoSolicitation.UnknownStatus)
	addBlocker(report, BlockerEchoReleaseUnknown, report.Counts.EchoRelease.UnknownStatus)
	report.Ready = len(report.Blockers) == 0
}

func addJobBlockers(report *Report, counts JobCounts, unknownCode, sendingCode, anomalyCode string) {
	addBlocker(report, unknownCode, counts.UnknownStatus)
	addBlocker(report, sendingCode, counts.Sending)
	addBlocker(report, anomalyCode, counts.LeaseAnomalies)
}

func addBlocker(report *Report, code string, count int64) {
	if report == nil || code == "" || count <= 0 {
		return
	}
	report.Blockers = append(report.Blockers, Blocker{Code: code, Count: count})
	report.Ready = false
}

func checkFailure(report Report, code string, err error) (Report, error) {
	addBlocker(&report, code, 1)
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return report, err
	}
	if errors.Is(err, ErrInvalidInput) {
		return report, ErrInvalidInput
	}
	return report, fmt.Errorf("%w: %s", ErrCheckFailed, code)
}

func rollbackReadOnly(tx pgx.Tx) {
	if tx == nil {
		return
	}
	rollbackCtx, cancel := context.WithTimeout(context.Background(), StatementTimeout)
	defer cancel()
	_ = tx.Rollback(rollbackCtx)
}

const schemaColumnsSQL = `
	WITH expected(table_name, column_name) AS (
	  VALUES
	    ('attachments', 'id'),
	    ('attachments', 'upload_transfer_id'),
    ('attachments', 'status'),
    ('transfer_ledger', 'id'),
    ('transfer_ledger', 'direction'),
    ('transfer_ledger', 'status'),
    ('transfer_ledger', 'last_activity_at'),
    ('transfer_ledger', 'created_at'),
    ('workspace_upload_parts', 'upload_id'),
    ('workspace_email_jobs', 'status'),
    ('workspace_email_jobs', 'next_attempt_at'),
    ('workspace_email_jobs', 'lease_until'),
    ('workspace_ntfy_jobs', 'status'),
    ('workspace_ntfy_jobs', 'next_attempt_at'),
    ('workspace_ntfy_jobs', 'lease_until'),
    ('workspace_email_digest_states', 'notified_at'),
    ('workspace_email_digest_states', 'lease_until'),
    ('echo_solicitation_deliveries', 'status'),
    ('echo_solicitation_deliveries', 'solicitation_id'),
    ('echo_solicitations', 'id'),
    ('echo_solicitations', 'status'),
    ('echo_release_deliveries', 'status')
), resolved AS (
  SELECT e.table_name, e.column_name, to_regclass(e.table_name) AS relation_oid
  FROM expected AS e
)
SELECT COUNT(*)
FROM resolved AS r
WHERE r.relation_oid IS NULL
   OR NOT EXISTS (
     SELECT 1
     FROM pg_class AS c
     WHERE c.oid = r.relation_oid
       AND c.relkind IN ('r', 'p')
   )
   OR NOT EXISTS (
     SELECT 1
     FROM pg_attribute AS a
     WHERE a.attrelid = r.relation_oid
       AND a.attname = r.column_name
       AND a.attnum > 0
       AND NOT a.attisdropped
   )`

func readMissingSchema(ctx context.Context, tx pgx.Tx) (int64, error) {
	var missing int64
	if err := tx.QueryRow(ctx, schemaColumnsSQL).Scan(&missing); err != nil {
		return 0, err
	}
	return missing, nil
}

const uploadCountsSQL = `
SELECT
  COUNT(DISTINCT tl.id) FILTER (WHERE tl.direction = 'upload' AND tl.status = 'reserved'),
  COUNT(DISTINCT tl.id) FILTER (
    WHERE tl.direction = 'upload'
      AND tl.status = 'reserved'
      AND COALESCE(tl.last_activity_at, tl.created_at) < $1
  ),
  COUNT(DISTINCT tl.id) FILTER (
    WHERE tl.direction = 'upload'
      AND tl.status = 'reserved'
      AND a.id IS NULL
  ),
  COUNT(DISTINCT tl.id) FILTER (
    WHERE tl.direction = 'upload'
      AND tl.status = 'reserved'
      AND a.id IS NOT NULL
      AND a.status IS DISTINCT FROM 'pending'
  ),
	  COUNT(DISTINCT tl.id) FILTER (
	    WHERE tl.direction = 'upload'
	      AND (tl.status IS NULL OR tl.status NOT IN ('reserved', 'completed', 'released', 'failed', 'rejected'))
	  )
FROM transfer_ledger AS tl
LEFT JOIN attachments AS a ON a.upload_transfer_id = tl.id`

const uploadPartCountsSQL = `
SELECT
  COUNT(*),
  COUNT(DISTINCT p.upload_id),
  COUNT(*) FILTER (WHERE tl.direction = 'upload' AND tl.status = 'reserved')
FROM workspace_upload_parts AS p
LEFT JOIN transfer_ledger AS tl ON tl.id = p.upload_id`

func readUploadCounts(ctx context.Context, tx pgx.Tx, now time.Time, counts *UploadCounts) error {
	if counts == nil {
		return ErrInvalidInput
	}
	cutoff := now.Add(-DefaultStaleUploadAge)
	if err := tx.QueryRow(ctx, uploadCountsSQL, cutoff).Scan(
		&counts.Reserved,
		&counts.StaleReserved,
		&counts.MissingAttachment,
		&counts.NonPendingAttachment,
		&counts.UnknownStatus,
	); err != nil {
		return err
	}
	return tx.QueryRow(ctx, uploadPartCountsSQL).Scan(
		&counts.PartRows,
		&counts.PartUploadCount,
		&counts.ReservedPartRows,
	)
}

const emailJobCountsSQL = `
SELECT
  COUNT(*) FILTER (WHERE status = 'pending'),
  COUNT(*) FILTER (WHERE status = 'sending'),
  COUNT(*) FILTER (WHERE status = 'sent'),
  COUNT(*) FILTER (WHERE status = 'cancelled'),
  COUNT(*) FILTER (WHERE status = 'failed'),
	COUNT(*) FILTER (WHERE status IS NULL OR status NOT IN ('pending', 'sending', 'sent', 'cancelled', 'failed')),
  COUNT(*) FILTER (WHERE lease_until > $1),
  COUNT(*) FILTER (WHERE lease_until <= $1),
  COUNT(*) FILTER (WHERE status = 'sending' AND lease_until IS NULL),
  COUNT(*) FILTER (WHERE status = 'sending' AND lease_until IS NOT NULL AND lease_until <= $1),
  COUNT(*) FILTER (WHERE (status IS NULL OR status <> 'sending') AND lease_until IS NOT NULL)
FROM workspace_email_jobs`

const ntfyJobCountsSQL = `
SELECT
  COUNT(*) FILTER (WHERE status = 'pending'),
  COUNT(*) FILTER (WHERE status = 'sending'),
  COUNT(*) FILTER (WHERE status = 'sent'),
  COUNT(*) FILTER (WHERE status = 'cancelled'),
  COUNT(*) FILTER (WHERE status = 'failed'),
	COUNT(*) FILTER (WHERE status IS NULL OR status NOT IN ('pending', 'sending', 'sent', 'cancelled', 'failed')),
  COUNT(*) FILTER (WHERE lease_until > $1),
  COUNT(*) FILTER (WHERE lease_until <= $1),
  COUNT(*) FILTER (WHERE status = 'sending' AND lease_until IS NULL),
  COUNT(*) FILTER (WHERE status = 'sending' AND lease_until IS NOT NULL AND lease_until <= $1),
  COUNT(*) FILTER (WHERE (status IS NULL OR status <> 'sending') AND lease_until IS NOT NULL)
FROM workspace_ntfy_jobs`

func readJobCounts(ctx context.Context, tx pgx.Tx, query string, now time.Time, counts *JobCounts) error {
	if counts == nil {
		return ErrInvalidInput
	}
	return tx.QueryRow(ctx, query, now).Scan(
		&counts.Pending,
		&counts.Sending,
		&counts.Sent,
		&counts.Cancelled,
		&counts.Failed,
		&counts.UnknownStatus,
		&counts.ActiveLeases,
		&counts.ExpiredLeases,
		&counts.SendingMissingLease,
		&counts.SendingExpiredLease,
		&counts.LeaseAnomalies,
	)
}

const digestCountsSQL = `
SELECT
  COUNT(*),
  COUNT(*) FILTER (WHERE notified_at IS NULL),
  COUNT(*) FILTER (WHERE notified_at IS NOT NULL),
  COUNT(*) FILTER (WHERE lease_until > $1),
  COUNT(*) FILTER (WHERE lease_until <= $1),
  COUNT(*) FILTER (WHERE notified_at IS NULL AND lease_until > $1),
  COUNT(*) FILTER (WHERE notified_at IS NULL AND lease_until IS NOT NULL AND lease_until <= $1),
  COUNT(*) FILTER (WHERE notified_at IS NULL AND lease_until IS NULL),
  COUNT(*) FILTER (WHERE notified_at IS NOT NULL AND lease_until IS NOT NULL)
FROM workspace_email_digest_states`

func readDigestCounts(ctx context.Context, tx pgx.Tx, now time.Time, counts *DigestCounts) error {
	if counts == nil {
		return ErrInvalidInput
	}
	return tx.QueryRow(ctx, digestCountsSQL, now).Scan(
		&counts.Rows,
		&counts.Unnotified,
		&counts.Notified,
		&counts.ActiveLeases,
		&counts.ExpiredLeases,
		&counts.UnnotifiedActiveLeases,
		&counts.UnnotifiedExpiredLeases,
		&counts.UnnotifiedWithoutLease,
		&counts.NotifiedWithLease,
	)
}

const echoSolicitationCountsSQL = `
SELECT
  COUNT(*) FILTER (WHERE d.status = 'pending'),
  COUNT(*) FILTER (WHERE d.status = 'sent'),
  COUNT(*) FILTER (WHERE d.status = 'failed'),
  COUNT(*) FILTER (WHERE d.status = 'skipped'),
	COUNT(*) FILTER (WHERE d.status IS NULL OR d.status NOT IN ('pending', 'sent', 'failed', 'skipped')),
  COUNT(*) FILTER (WHERE d.status = 'sent' AND s.status IN ('open', 'closed', 'withdrawn'))
FROM echo_solicitation_deliveries AS d
LEFT JOIN echo_solicitations AS s ON s.id = d.solicitation_id`

const echoReleaseCountsSQL = `
SELECT
  COUNT(*) FILTER (WHERE status = 'pending'),
  COUNT(*) FILTER (WHERE status = 'sent'),
  COUNT(*) FILTER (WHERE status = 'failed'),
  COUNT(*) FILTER (WHERE status = 'skipped'),
	COUNT(*) FILTER (WHERE status IS NULL OR status NOT IN ('pending', 'sent', 'failed', 'skipped'))
FROM echo_release_deliveries`

func readEchoSolicitationCounts(ctx context.Context, tx pgx.Tx, counts *DeliveryCounts) error {
	if counts == nil {
		return ErrInvalidInput
	}
	return tx.QueryRow(ctx, echoSolicitationCountsSQL).Scan(
		&counts.Pending,
		&counts.Sent,
		&counts.Failed,
		&counts.Skipped,
		&counts.UnknownStatus,
		&counts.Reconcile,
	)
}

func readEchoReleaseCounts(ctx context.Context, tx pgx.Tx, counts *DeliveryCounts) error {
	if counts == nil {
		return ErrInvalidInput
	}
	return tx.QueryRow(ctx, echoReleaseCountsSQL).Scan(
		&counts.Pending,
		&counts.Sent,
		&counts.Failed,
		&counts.Skipped,
		&counts.UnknownStatus,
	)
}
