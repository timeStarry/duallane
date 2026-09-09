package metrics

import "time"

// WorkerOperation is a fixed worker processor category. Bot Gateway queue
// replay intentionally has no worker operation: it remains owned by the
// Workspace process and is not given a second claimer here.
type WorkerOperation string

const (
	WorkerOperationEmail                    WorkerOperation = "email"
	WorkerOperationNtfy                     WorkerOperation = "ntfy"
	WorkerOperationPresenceExpiry           WorkerOperation = "presence_expiry"
	WorkerOperationEchoSolicitationDelivery WorkerOperation = "echo_solicitation_delivery"
	WorkerOperationEchoRequirementDelivery  WorkerOperation = "echo_requirement_delivery"
	WorkerOperationEchoReleaseDelivery      WorkerOperation = "echo_release_delivery"
	WorkerOperationEchoMemberReconciliation WorkerOperation = "echo_member_reconciliation"
	WorkerOperationUploadStorageMaintenance WorkerOperation = "upload_storage_maintenance"
	WorkerOperationMultipartMaintenance     WorkerOperation = "multipart_maintenance"
	WorkerOperationOther                    WorkerOperation = "other"
)

// WorkerBacklogSnapshot is a read-only, already aggregated worker view.
type WorkerBacklogSnapshot struct {
	Pending           int64
	OldestAge         time.Duration
	OldestLeaseAge    time.Duration
	LeaseAgeAvailable bool
}

// WorkerResultKind is a fixed result category for a worker processor.
type WorkerResultKind string

const (
	WorkerResultEligible     WorkerResultKind = "eligible"
	WorkerResultClaimed      WorkerResultKind = "claimed"
	WorkerResultCompleted    WorkerResultKind = "completed"
	WorkerResultFailed       WorkerResultKind = "failed"
	WorkerResultCancelled    WorkerResultKind = "cancelled"
	WorkerResultRetried      WorkerResultKind = "retried"
	WorkerResultLeaseExpired WorkerResultKind = "lease_expired"
	WorkerResultOther        WorkerResultKind = "other"
)

// WorkerResult carries non-negative counts for one bounded processing cycle.
// It contains no job IDs, recipients, provider errors, or payload data.
type WorkerResult struct {
	Eligible     int64
	Claimed      int64
	Completed    int64
	Failed       int64
	Cancelled    int64
	Retried      int64
	LeaseExpired int64
}

// SetWorkerBacklog updates backlog and available age gauges for a fixed worker
// operation. Negative values are clamped to zero. Lease age is optional:
// callers must set LeaseAgeAvailable only when the source has an acquired-at
// timestamp. An unavailable value neither creates nor overwrites that gauge.
func (m *Metrics) SetWorkerBacklog(operation WorkerOperation, snapshot WorkerBacklogSnapshot) {
	if m == nil {
		return
	}
	operationLabel := normalizeWorkerOperation(operation)
	m.workerBacklog.WithLabelValues(operationLabel).Set(nonNegativeFloat(snapshot.Pending))
	m.workerBacklogAge.WithLabelValues(operationLabel).Set(nonNegativeDuration(snapshot.OldestAge))
	if snapshot.LeaseAgeAvailable {
		m.workerLeaseAge.WithLabelValues(operationLabel).Set(nonNegativeDuration(snapshot.OldestLeaseAge))
	}
}

// ObserveWorkerResult records all positive counts in a bounded worker result.
func (m *Metrics) ObserveWorkerResult(operation WorkerOperation, result WorkerResult) {
	if m == nil {
		return
	}
	m.ObserveWorkerOutcome(operation, WorkerResultEligible, result.Eligible)
	m.ObserveWorkerOutcome(operation, WorkerResultClaimed, result.Claimed)
	m.ObserveWorkerOutcome(operation, WorkerResultCompleted, result.Completed)
	m.ObserveWorkerOutcome(operation, WorkerResultFailed, result.Failed)
	m.ObserveWorkerOutcome(operation, WorkerResultCancelled, result.Cancelled)
	m.ObserveWorkerOutcome(operation, WorkerResultRetried, result.Retried)
	m.ObserveWorkerOutcome(operation, WorkerResultLeaseExpired, result.LeaseExpired)
}

// ObserveWorkerOutcome adds a positive count to one fixed result category.
func (m *Metrics) ObserveWorkerOutcome(operation WorkerOperation, result WorkerResultKind, count int64) {
	if m == nil || count <= 0 {
		return
	}
	m.workerResults.WithLabelValues(normalizeWorkerOperation(operation), normalizeWorkerResult(result)).Add(float64(count))
}

func nonNegativeDuration(value time.Duration) float64 {
	if value < 0 {
		return 0
	}
	return value.Seconds()
}
