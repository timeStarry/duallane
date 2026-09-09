package releasecheck

import (
	"context"
	"testing"
)

func TestFinalizeKeepsQueuedAndEchoWorkAsObservations(t *testing.T) {
	report := newReport()
	report.Counts.EmailJobs.Pending = 2
	report.Counts.NtfyJobs.Pending = 1
	report.Counts.EmailDigest.UnnotifiedWithoutLease = 1
	report.Counts.EchoSolicitation.Pending = 3
	report.Counts.EchoSolicitation.Failed = 1
	report.Counts.EchoSolicitation.Reconcile = 2
	report.Counts.EchoRelease.Pending = 1

	finalize(&report)
	if !report.Ready {
		t.Fatalf("queued/reconciliation work made report unready: %#v", report.Blockers)
	}
	if len(report.Blockers) != 0 {
		t.Fatalf("unexpected blockers: %#v", report.Blockers)
	}
}

func TestFinalizeBlocksReservedUploadsAndAttachmentAnomalies(t *testing.T) {
	report := newReport()
	report.Counts.Uploads.Reserved = 4
	report.Counts.Uploads.StaleReserved = 2
	report.Counts.Uploads.MissingAttachment = 1
	report.Counts.Uploads.NonPendingAttachment = 1
	report.Counts.Uploads.PartRows = 9

	finalize(&report)
	if report.Ready {
		t.Fatal("reserved upload report was ready")
	}
	assertBlockerCount(t, report, BlockerUploadReserved, 4)
	assertBlockerCount(t, report, BlockerUploadMissingAttachment, 1)
	assertBlockerCount(t, report, BlockerUploadNonPending, 1)
	if got := blockerCount(report, BlockerUploadUnknownStatus); got != 0 {
		t.Fatalf("unknown upload blocker count = %d", got)
	}
}

func TestFinalizeBlocksEverySendingLeaseShape(t *testing.T) {
	report := newReport()
	report.Counts.EmailJobs.Sending = 3
	report.Counts.EmailJobs.SendingMissingLease = 1
	report.Counts.EmailJobs.SendingExpiredLease = 1
	report.Counts.EmailJobs.LeaseAnomalies = 1
	report.Counts.EmailJobs.UnknownStatus = 1
	report.Counts.NtfyJobs.Sending = 1
	report.Counts.NtfyJobs.LeaseAnomalies = 1
	report.Counts.EmailDigest.UnnotifiedActiveLeases = 1
	report.Counts.EmailDigest.NotifiedWithLease = 1

	finalize(&report)
	if report.Ready {
		t.Fatal("active/expired/missing sending leases made report ready")
	}
	assertBlockerCount(t, report, BlockerEmailSending, 3)
	assertBlockerCount(t, report, BlockerEmailLeaseAnomaly, 1)
	assertBlockerCount(t, report, BlockerEmailUnknownStatus, 1)
	assertBlockerCount(t, report, BlockerNtfySending, 1)
	assertBlockerCount(t, report, BlockerNtfyLeaseAnomaly, 1)
	assertBlockerCount(t, report, BlockerDigestActiveLease, 1)
	assertBlockerCount(t, report, BlockerDigestLeaseAnomaly, 1)
}

func TestNewReportDoesNotClaimFenceOrProviderCoverage(t *testing.T) {
	report := newReport()
	if report.Ready {
		t.Fatal("empty report unexpectedly marked ready before a snapshot")
	}
	if report.Writers.Status != ObservationNotProven || report.Provider.Status != ObservationNotChecked {
		t.Fatalf("unsafe external-state observation: writers=%#v provider=%#v", report.Writers, report.Provider)
	}
	if report.Writers.ReasonCode == "" || report.Provider.ReasonCode == "" {
		t.Fatal("external-state limitation was not described")
	}
}

func TestCheckRejectsInvalidInputsWithoutDatabaseAccess(t *testing.T) {
	if report, err := Check(context.Background(), nil); err != ErrInvalidInput || report.Ready || !report.ReadOnly {
		t.Fatalf("nil pool result = %#v, %v", report, err)
	}
}

func assertBlockerCount(t *testing.T, report Report, code string, want int64) {
	t.Helper()
	if got := blockerCount(report, code); got != want {
		t.Fatalf("blocker %q count = %d, want %d; blockers=%#v", code, got, want, report.Blockers)
	}
}

func blockerCount(report Report, code string) int64 {
	for _, blocker := range report.Blockers {
		if blocker.Code == code {
			return blocker.Count
		}
	}
	return 0
}
