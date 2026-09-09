package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	platformmetrics "github.com/timestarry/duallane/apps/backend/internal/platform/metrics"
)

type workerBacklogRecorderSpy struct {
	order     []platformmetrics.WorkerOperation
	snapshots map[platformmetrics.WorkerOperation]platformmetrics.WorkerBacklogSnapshot
}

func (s *workerBacklogRecorderSpy) SetWorkerBacklog(operation platformmetrics.WorkerOperation, snapshot platformmetrics.WorkerBacklogSnapshot) {
	if s.snapshots == nil {
		s.snapshots = make(map[platformmetrics.WorkerOperation]platformmetrics.WorkerBacklogSnapshot)
	}
	s.order = append(s.order, operation)
	s.snapshots[operation] = snapshot
}

func TestWorkerBacklogAggregationAndRecording(t *testing.T) {
	now := time.Date(2026, 9, 6, 13, 0, 0, 0, time.UTC)
	oldestEmail := now.Add(-4 * time.Hour)
	oldestDigest := now.Add(-5 * time.Hour)
	oldestNtfy := now.Add(-2 * time.Hour)
	rows := []workerBacklogRow{
		{operation: platformmetrics.WorkerOperationEmail, pending: 2, oldestAt: &oldestEmail},
		{operation: platformmetrics.WorkerOperationEmail, pending: 1, oldestAt: &oldestDigest},
		{operation: platformmetrics.WorkerOperationNtfy, pending: 1, oldestAt: &oldestNtfy},
	}

	var aggregates map[platformmetrics.WorkerOperation]workerBacklogAggregate
	for _, row := range rows {
		if row.pending < 0 || !workerBacklogOperationAllowed(row.operation) {
			t.Fatalf("fixture row rejected before aggregation: %+v", row)
		}
		aggregates = aggregateWorkerBacklogRow(aggregates, row)
	}

	recorder := &workerBacklogRecorderSpy{}
	recordWorkerBacklog(recorder, now, aggregates)
	if len(recorder.order) != len(workerBacklogOperations) {
		t.Fatalf("recorded operation count=%d want=%d", len(recorder.order), len(workerBacklogOperations))
	}
	if got := recorder.snapshots[platformmetrics.WorkerOperationEmail]; got.Pending != 3 || got.OldestAge != 5*time.Hour || got.OldestLeaseAge != 0 {
		t.Fatalf("email snapshot=%+v", got)
	}
	if got := recorder.snapshots[platformmetrics.WorkerOperationNtfy]; got.Pending != 1 || got.OldestAge != 2*time.Hour || got.OldestLeaseAge != 0 {
		t.Fatalf("ntfy snapshot=%+v", got)
	}
	if got := recorder.snapshots[platformmetrics.WorkerOperationUploadStorageMaintenance]; got != (platformmetrics.WorkerBacklogSnapshot{}) {
		t.Fatalf("empty operation snapshot=%+v", got)
	}
	for _, operation := range []platformmetrics.WorkerOperation{
		platformmetrics.WorkerOperationEchoMemberReconciliation,
		platformmetrics.WorkerOperationMultipartMaintenance,
	} {
		if _, ok := recorder.snapshots[operation]; ok {
			t.Fatalf("non-durable operation %q was recorded", operation)
		}
	}
}

func TestWorkerBacklogRejectsInvalidRows(t *testing.T) {
	if !workerBacklogOperationAllowed(platformmetrics.WorkerOperationEmail) {
		t.Fatal("email operation is not allowlisted")
	}
	if workerBacklogOperationAllowed(platformmetrics.WorkerOperation("secret-row")) {
		t.Fatal("unknown operation is allowlisted")
	}
	if _, err := validateWorkerBacklogRow(workerBacklogRow{operation: platformmetrics.WorkerOperationEmail, pending: -1}); !errors.Is(err, errWorkerMetricsRowInvalid) {
		t.Fatalf("negative pending error=%v", err)
	}
	if _, err := validateWorkerBacklogRow(workerBacklogRow{operation: platformmetrics.WorkerOperation("secret-row")}); !errors.Is(err, errWorkerMetricsRowInvalid) {
		t.Fatalf("unknown operation error=%v", err)
	}
	if _, err := validateWorkerBacklogRow(workerBacklogRow{operation: platformmetrics.WorkerOperationEmail, pending: 2}); err != nil {
		t.Fatalf("valid row error=%v", err)
	}
}

func TestWorkerMetricsAgeClampsFutureAndEmptyTimes(t *testing.T) {
	now := time.Date(2026, 9, 6, 13, 0, 0, 0, time.UTC)
	future := now.Add(time.Minute)
	if got := workerMetricsAge(now, &future); got != 0 {
		t.Fatalf("future age=%s", got)
	}
	if got := workerMetricsAge(now, nil); got != 0 {
		t.Fatalf("empty age=%s", got)
	}
	old := now.Add(-time.Minute)
	if got := workerMetricsAge(now, &old); got != time.Minute {
		t.Fatalf("old age=%s", got)
	}
}

func TestWorkerMetricsBudgetAndCancellation(t *testing.T) {
	if workerMetricsReadBudget > 500*time.Millisecond {
		t.Fatalf("read budget=%s exceeds 500ms", workerMetricsReadBudget)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := collectWorkerBacklog(ctx, nil, &workerBacklogRecorderSpy{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled collection error=%v", err)
	}
}

func TestWorkerBacklogQueryStaysAggregateAndContentFree(t *testing.T) {
	for _, forbidden := range []string{"SELECT *", "user_id", "message_id", "provider", "last_error_code"} {
		if strings.Contains(strings.ToLower(workerBacklogQuery), strings.ToLower(forbidden)) {
			t.Fatalf("worker backlog query contains forbidden %q", forbidden)
		}
	}
	if strings.Contains(strings.ToLower(workerBacklogQuery), "insert ") || strings.Contains(strings.ToLower(workerBacklogQuery), "update ") || strings.Contains(strings.ToLower(workerBacklogQuery), "delete ") {
		t.Fatal("worker backlog query is not read-only")
	}
}
