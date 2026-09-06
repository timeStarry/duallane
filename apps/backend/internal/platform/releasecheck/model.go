// Package releasecheck provides a bounded, read-only PostgreSQL drain
// observation for a coordinated release cutover.
//
// The package does not fence writers, stop services, inspect object-storage
// provider state, or perform cleanup. Ready only describes the durable
// database state observed by one snapshot; callers must separately establish
// admission fencing, restart protection, process quiescence, and provider
// state before treating a report as a cutover input.
package releasecheck

import "time"

const (
	// DefaultCheckTimeout bounds the complete snapshot, including all fixed
	// metadata and aggregate queries.
	DefaultCheckTimeout = 2 * time.Second
	// StatementTimeout is applied locally to every statement in the read-only
	// transaction. The value is deliberately shorter than the outer bound.
	StatementTimeout = 500 * time.Millisecond
	// DefaultStaleUploadAge matches the existing Node and Go upload maintenance
	// policy. Check only reports this age; it never releases the reservation.
	DefaultStaleUploadAge = 30 * time.Minute
)

const (
	ObservationNotProven  = "not_proven"
	ObservationNotChecked = "not_checked"
)

const (
	BlockerSchemaUnavailable       = "schema_unavailable"
	BlockerSchemaIncompatible      = "schema_incompatible"
	BlockerUploadReserved          = "upload_reserved"
	BlockerUploadMissingAttachment = "upload_missing_attachment"
	BlockerUploadNonPending        = "upload_nonpending_attachment"
	BlockerUploadUnknownStatus     = "upload_unknown_status"
	BlockerEmailSending            = "email_sending"
	BlockerEmailLeaseAnomaly       = "email_lease_anomaly"
	BlockerEmailUnknownStatus      = "email_unknown_status"
	BlockerNtfySending             = "ntfy_sending"
	BlockerNtfyLeaseAnomaly        = "ntfy_lease_anomaly"
	BlockerNtfyUnknownStatus       = "ntfy_unknown_status"
	BlockerDigestActiveLease       = "email_digest_active_lease"
	BlockerDigestLeaseAnomaly      = "email_digest_lease_anomaly"
	BlockerEchoSolicitationUnknown = "echo_solicitation_unknown_status"
	BlockerEchoReleaseUnknown      = "echo_release_unknown_status"
	BlockerSnapshotFailed          = "snapshot_failed"
)

// Report is a content-free result of one repeatable-read PostgreSQL snapshot.
// It intentionally contains no IDs, paths, provider details, or raw SQL
// errors.
type Report struct {
	Ready      bool                `json:"ready"`
	ReadOnly   bool                `json:"readOnly"`
	SnapshotAt time.Time           `json:"snapshotAt"`
	Counts     Counts              `json:"counts"`
	Blockers   []Blocker           `json:"blockers"`
	Writers    WriterObservation   `json:"writers"`
	Provider   ProviderObservation `json:"provider"`
}

// Blocker is a fixed, safe category with a count. Counts are aggregate-only;
// no row identity or database error is returned.
type Blocker struct {
	Code  string `json:"code"`
	Count int64  `json:"count"`
}

// WriterObservation deliberately reports that this package did not prove a
// complete view of other writers. It is not a fencing mechanism.
type WriterObservation struct {
	Status     string `json:"status"`
	ReasonCode string `json:"reasonCode"`
}

// ProviderObservation records the intentionally unsupported part of this
// check. SQL cannot prove the state of S3 or another object-storage provider.
type ProviderObservation struct {
	Status     string `json:"status"`
	ReasonCode string `json:"reasonCode"`
}

// Counts contains only fixed-domain aggregates from the database snapshot.
type Counts struct {
	Schema           SchemaCounts   `json:"schema"`
	Uploads          UploadCounts   `json:"uploads"`
	EmailJobs        JobCounts      `json:"emailJobs"`
	NtfyJobs         JobCounts      `json:"ntfyJobs"`
	EmailDigest      DigestCounts   `json:"emailDigest"`
	EchoSolicitation DeliveryCounts `json:"echoSolicitation"`
	EchoRelease      DeliveryCounts `json:"echoRelease"`
}

type SchemaCounts struct {
	MissingItems int64 `json:"missingItems"`
}

// UploadCounts distinguishes logical reservations from part rows. Part rows
// are observations only and never make a transfer safe to hand off.
type UploadCounts struct {
	Reserved             int64 `json:"reserved"`
	StaleReserved        int64 `json:"staleReserved"`
	MissingAttachment    int64 `json:"missingAttachment"`
	NonPendingAttachment int64 `json:"nonPendingAttachment"`
	PartRows             int64 `json:"partRows"`
	PartUploadCount      int64 `json:"partUploadCount"`
	ReservedPartRows     int64 `json:"reservedPartRows"`
	UnknownStatus        int64 `json:"unknownStatus"`
}

// JobCounts describes both queue state and lease anomalies. A sending row is
// blocking regardless of whether its lease is active, expired, or missing.
type JobCounts struct {
	Pending             int64 `json:"pending"`
	Sending             int64 `json:"sending"`
	Sent                int64 `json:"sent"`
	Cancelled           int64 `json:"cancelled"`
	Failed              int64 `json:"failed"`
	UnknownStatus       int64 `json:"unknownStatus"`
	ActiveLeases        int64 `json:"activeLeases"`
	ExpiredLeases       int64 `json:"expiredLeases"`
	SendingMissingLease int64 `json:"sendingMissingLease"`
	SendingExpiredLease int64 `json:"sendingExpiredLease"`
	LeaseAnomalies      int64 `json:"leaseAnomalies"`
}

type DigestCounts struct {
	Rows                    int64 `json:"rows"`
	Unnotified              int64 `json:"unnotified"`
	Notified                int64 `json:"notified"`
	ActiveLeases            int64 `json:"activeLeases"`
	ExpiredLeases           int64 `json:"expiredLeases"`
	UnnotifiedActiveLeases  int64 `json:"unnotifiedActiveLeases"`
	UnnotifiedExpiredLeases int64 `json:"unnotifiedExpiredLeases"`
	UnnotifiedWithoutLease  int64 `json:"unnotifiedWithoutLease"`
	NotifiedWithLease       int64 `json:"notifiedWithLease"`
}

// DeliveryCounts intentionally calls Echo rows observations rather than
// claims. Echo has no durable lease; pending/failed rows and solicitation
// reconciliation are reported without changing readiness.
type DeliveryCounts struct {
	Pending       int64 `json:"pending"`
	Sent          int64 `json:"sent"`
	Failed        int64 `json:"failed"`
	Skipped       int64 `json:"skipped"`
	UnknownStatus int64 `json:"unknownStatus"`
	Reconcile     int64 `json:"reconcile"`
}
