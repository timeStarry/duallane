package main

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	platformmetrics "github.com/timestarry/duallane/apps/backend/internal/platform/metrics"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/files"
)

const workerMetricsReadBudget = 500 * time.Millisecond

var (
	errWorkerMetricsUnavailable = errors.New("worker metrics collection unavailable")
	errWorkerMetricsRowInvalid  = errors.New("worker metrics row invalid")
)

// workerBacklogRecorder is the only platform surface required by this
// collector. A concrete platform metrics.Metrics satisfies it, while the
// narrow seam keeps collection tests independent of the rest of the recorder.
type workerBacklogRecorder interface {
	SetWorkerBacklog(platformmetrics.WorkerOperation, platformmetrics.WorkerBacklogSnapshot)
}

var _ workerBacklogRecorder = (*platformmetrics.Metrics)(nil)

// workerBacklogOperations are the durable queue families represented by this
// collector. Echo member reconciliation is a bounded membership scan and
// multipart maintenance is provider-only; neither has a PostgreSQL backlog
// that can be measured here without inventing state or making provider calls.
var workerBacklogOperations = [...]platformmetrics.WorkerOperation{
	platformmetrics.WorkerOperationEmail,
	platformmetrics.WorkerOperationNtfy,
	platformmetrics.WorkerOperationPresenceExpiry,
	platformmetrics.WorkerOperationEchoSolicitationDelivery,
	platformmetrics.WorkerOperationEchoRequirementDelivery,
	platformmetrics.WorkerOperationEchoReleaseDelivery,
	platformmetrics.WorkerOperationUploadStorageMaintenance,
}

// workerBacklogQuery intentionally contains only fixed table names and
// aggregate expressions. It returns no user, message, provider, or object
// identifiers. $1 is one collection timestamp; $2 is the upload maintenance
// stale cutoff, matching files.DefaultStaleUploadAge.
// Echo solicitation rows in the work predicate include sent rows whose source
// remains active because the worker reconciles them; they are not pending
// sends. Echo requirement recovery deliberately has no status predicate: the
// owning repository's ListRequirementsForRecovery scans every requirement row
// in ID order.
const workerBacklogQuery = `
SELECT 'email'::text AS operation,
       COUNT(*) FILTER (
         WHERE status IN ('pending', 'sending')
           AND next_attempt_at <= $1
           AND (lease_until IS NULL OR lease_until <= $1)
       )::bigint AS pending,
       MIN(created_at) FILTER (
         WHERE status IN ('pending', 'sending')
           AND next_attempt_at <= $1
           AND (lease_until IS NULL OR lease_until <= $1)
       ) AS oldest_at,
       NULL::timestamptz AS oldest_lease_at
FROM workspace_email_jobs
UNION ALL
SELECT 'email'::text,
       COUNT(*) FILTER (
         WHERE notified_at IS NULL
           AND next_attempt_at <= $1
           AND (lease_until IS NULL OR lease_until <= $1)
       )::bigint,
       MIN(started_at) FILTER (
         WHERE notified_at IS NULL
           AND next_attempt_at <= $1
           AND (lease_until IS NULL OR lease_until <= $1)
       ),
       NULL::timestamptz
FROM workspace_email_digest_states
UNION ALL
SELECT 'ntfy'::text,
       COUNT(*) FILTER (
         WHERE status IN ('pending', 'sending')
           AND next_attempt_at <= $1
           AND (lease_until IS NULL OR lease_until <= $1)
       )::bigint,
       MIN(created_at) FILTER (
         WHERE status IN ('pending', 'sending')
           AND next_attempt_at <= $1
           AND (lease_until IS NULL OR lease_until <= $1)
       ),
       NULL::timestamptz
FROM workspace_ntfy_jobs
UNION ALL
SELECT 'echo_solicitation_delivery'::text,
       COUNT(*) FILTER (
         WHERE d.status IN ('pending', 'failed')
            OR (d.status = 'sent' AND s.status IN ('open', 'closed', 'withdrawn'))
       )::bigint,
       MIN(d.created_at) FILTER (
         WHERE d.status IN ('pending', 'failed')
            OR (d.status = 'sent' AND s.status IN ('open', 'closed', 'withdrawn'))
       ),
       NULL::timestamptz
FROM echo_solicitation_deliveries d
INNER JOIN echo_solicitations s
  ON s.id = d.solicitation_id AND s.space_id = d.space_id
UNION ALL
SELECT 'echo_requirement_delivery'::text,
       COUNT(*)::bigint,
       MIN(updated_at),
       NULL::timestamptz
FROM echo_requirements
UNION ALL
SELECT 'echo_release_delivery'::text,
       COUNT(*) FILTER (WHERE status IN ('pending', 'failed'))::bigint,
       MIN(created_at) FILTER (WHERE status IN ('pending', 'failed')),
       NULL::timestamptz
FROM echo_release_deliveries
UNION ALL
SELECT 'presence_expiry'::text,
       COUNT(*) FILTER (WHERE lease_until <= $1)::bigint,
       MIN(lease_until) FILTER (WHERE lease_until <= $1),
       NULL::timestamptz
FROM workspace_presence_leases
UNION ALL
SELECT 'upload_storage_maintenance'::text,
       COUNT(*) FILTER (
         WHERE (
           (tl.status = 'reserved' AND a.status = 'pending')
           OR tl.status IN ('completed', 'failed', 'released')
         )
         AND COALESCE(tl.last_activity_at, tl.created_at) < $2
       )::bigint,
       MIN(COALESCE(tl.last_activity_at, tl.created_at)) FILTER (
         WHERE (
           (tl.status = 'reserved' AND a.status = 'pending')
           OR tl.status IN ('completed', 'failed', 'released')
         )
         AND COALESCE(tl.last_activity_at, tl.created_at) < $2
       ),
       NULL::timestamptz
FROM transfer_ledger tl
INNER JOIN attachments a ON a.id = tl.attachment_id
WHERE tl.direction = 'upload'
`

type workerBacklogRow struct {
	operation platformmetrics.WorkerOperation
	pending   int64
	oldestAt  *time.Time
}

type workerBacklogAggregate struct {
	pending  int64
	oldestAt *time.Time
}

// collectWorkerBacklog is the parent-facing worker composition API. It opens
// one bounded PostgreSQL read-only transaction, records only fixed aggregate
// gauges, and never invokes a notification or object-store provider. The
// parent worker should call it from its 30-second ticker; it deliberately has
// no process-global cache. If collection fails, no gauges are updated, so the
// recorder retains the last successful sample.
func collectWorkerBacklog(ctx context.Context, pool *pgxpool.Pool, recorder workerBacklogRecorder) error {
	if ctx == nil {
		return errWorkerMetricsUnavailable
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if pool == nil || recorder == nil {
		return errWorkerMetricsUnavailable
	}

	readCtx, cancel := context.WithTimeout(ctx, workerMetricsReadBudget)
	defer cancel()
	tx, err := pool.BeginTx(readCtx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return workerMetricsContextError(readCtx, err)
	}
	defer rollbackWorkerMetrics(tx)

	now := time.Now().UTC()
	rows, err := tx.Query(readCtx, workerBacklogQuery, now, now.Add(-files.DefaultStaleUploadAge))
	if err != nil {
		return workerMetricsContextError(readCtx, err)
	}
	aggregates, err := scanWorkerBacklogRows(rows)
	if err != nil {
		return workerMetricsContextError(readCtx, err)
	}
	if err := readCtx.Err(); err != nil {
		return err
	}
	recordWorkerBacklog(recorder, now, aggregates)
	return nil
}

func workerMetricsContextError(ctx context.Context, err error) error {
	if ctxErr := ctx.Err(); ctxErr != nil {
		return ctxErr
	}
	if err == nil {
		return nil
	}
	return errWorkerMetricsUnavailable
}

func rollbackWorkerMetrics(tx pgx.Tx) {
	if tx == nil {
		return
	}
	rollbackCtx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_ = tx.Rollback(rollbackCtx)
}

func scanWorkerBacklogRows(rows pgx.Rows) (map[platformmetrics.WorkerOperation]workerBacklogAggregate, error) {
	if rows == nil {
		return nil, errWorkerMetricsRowInvalid
	}
	defer rows.Close()
	aggregates := make(map[platformmetrics.WorkerOperation]workerBacklogAggregate, len(workerBacklogOperations))
	for _, operation := range workerBacklogOperations {
		aggregates[operation] = workerBacklogAggregate{}
	}
	for rows.Next() {
		var operation string
		var pending int64
		var oldestAt pgtype.Timestamptz
		var ignoredLeaseAt pgtype.Timestamptz
		if err := rows.Scan(&operation, &pending, &oldestAt, &ignoredLeaseAt); err != nil {
			return nil, errWorkerMetricsRowInvalid
		}
		row := workerBacklogRow{
			operation: platformmetrics.WorkerOperation(operation),
			pending:   pending,
			oldestAt:  workerMetricsTimePointer(oldestAt),
		}
		if _, err := validateWorkerBacklogRow(row); err != nil {
			return nil, err
		}
		aggregates = aggregateWorkerBacklogRow(aggregates, row)
	}
	if err := rows.Err(); err != nil {
		return nil, errWorkerMetricsRowInvalid
	}
	return aggregates, nil
}

func validateWorkerBacklogRow(row workerBacklogRow) (workerBacklogRow, error) {
	if row.pending < 0 || !workerBacklogOperationAllowed(row.operation) {
		return workerBacklogRow{}, errWorkerMetricsRowInvalid
	}
	return row, nil
}

func aggregateWorkerBacklogRow(aggregates map[platformmetrics.WorkerOperation]workerBacklogAggregate, row workerBacklogRow) map[platformmetrics.WorkerOperation]workerBacklogAggregate {
	if aggregates == nil {
		aggregates = make(map[platformmetrics.WorkerOperation]workerBacklogAggregate, len(workerBacklogOperations))
	}
	aggregate := aggregates[row.operation]
	aggregate.pending += row.pending
	aggregate.oldestAt = olderWorkerMetricsTime(aggregate.oldestAt, row.oldestAt)
	aggregates[row.operation] = aggregate
	return aggregates
}

func workerMetricsTimePointer(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	result := value.Time.UTC()
	return &result
}

func olderWorkerMetricsTime(current, candidate *time.Time) *time.Time {
	if candidate == nil {
		return current
	}
	if current == nil || candidate.Before(*current) {
		result := candidate.UTC()
		return &result
	}
	return current
}

func workerBacklogOperationAllowed(operation platformmetrics.WorkerOperation) bool {
	for _, allowed := range workerBacklogOperations {
		if operation == allowed {
			return true
		}
	}
	return false
}

func recordWorkerBacklog(recorder workerBacklogRecorder, now time.Time, aggregates map[platformmetrics.WorkerOperation]workerBacklogAggregate) {
	if recorder == nil {
		return
	}
	for _, operation := range workerBacklogOperations {
		recorder.SetWorkerBacklog(operation, workerBacklogSnapshot(now, aggregates[operation]))
	}
}

func workerBacklogSnapshot(now time.Time, aggregate workerBacklogAggregate) platformmetrics.WorkerBacklogSnapshot {
	// The queue tables expose lease_until but not the timestamp at which a
	// lease was acquired. Do not infer a hold duration from created_at or
	// lease_until; the shared snapshot's lease-age field remains zero until a
	// durable acquired-at value exists. Expired leases are counted as pending.
	return platformmetrics.WorkerBacklogSnapshot{
		Pending:   aggregate.pending,
		OldestAge: workerMetricsAge(now, aggregate.oldestAt),
	}
}

func workerMetricsAge(now time.Time, at *time.Time) time.Duration {
	if at == nil {
		return 0
	}
	age := now.UTC().Sub(at.UTC())
	if age < 0 {
		return 0
	}
	return age
}
