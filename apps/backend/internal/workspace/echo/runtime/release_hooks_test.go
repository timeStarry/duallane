package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strconv"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/delivery"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/releases"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/interactions"
)

type releaseDeliveryStub struct {
	calls       []string
	deadlineSet bool
	result      delivery.DeliverySummary
	err         error
}

func (s *releaseDeliveryStub) SyncRequirement(context.Context, delivery.SyncInput) (delivery.DeliverySummary, error) {
	return delivery.DeliverySummary{}, nil
}
func (s *releaseDeliveryStub) SyncSolicitation(context.Context, delivery.SyncInput) (delivery.DeliverySummary, error) {
	return delivery.DeliverySummary{}, nil
}
func (s *releaseDeliveryStub) SyncRelease(ctx context.Context, input delivery.SyncInput) (delivery.DeliverySummary, error) {
	s.calls = append(s.calls, "delivery:"+input.Version)
	_, s.deadlineSet = ctx.Deadline()
	if s.err != nil {
		return delivery.DeliverySummary{}, s.err
	}
	return s.result, nil
}

type releaseReaderStub struct {
	calls   []string
	summary *releases.PublicationSummary
	err     error
}

func (s *releaseReaderStub) GetPublication(_ context.Context, version string) (*releases.PublicationSummary, error) {
	s.calls = append(s.calls, "reader:"+version)
	return s.summary, s.err
}

type releaseFinalizerStub struct {
	calls   []string
	input   interactions.FinalizeCommandResultInput
	outcome interactions.CommandOutcome
	err     error
}

func (s *releaseFinalizerStub) FinalizeCommandResult(_ context.Context, input interactions.FinalizeCommandResultInput) (interactions.CommandOutcome, error) {
	s.calls = append(s.calls, "finalizer")
	s.input = input
	if s.err != nil {
		return interactions.CommandOutcome{}, s.err
	}
	if s.outcome.Result == nil {
		s.outcome.Result = input.Result
	}
	return s.outcome, nil
}

func releaseHookResult() map[string]any {
	return map[string]any{
		"type":           "release-published",
		"version":        "1.2.3",
		"title":          "Original title",
		"recipientCount": int64(3),
		"pendingCount":   int64(3),
		"sentCount":      int64(0),
		"failedCount":    int64(0),
		"skippedCount":   int64(0),
		"replayed":       false,
		"identity":       map[string]any{"publication": "immutable", "text": "preserve me"},
	}
}

func releaseHookPublication() *releases.PublicationSummary {
	return &releases.PublicationSummary{
		ID:             "echo_release_publication_1",
		Version:        "1.2.3",
		Title:          "Reader title must not replace response title",
		RecipientCount: 3,
		PendingCount:   0,
		SentCount:      2,
		FailedCount:    1,
		SkippedCount:   0,
	}
}

func TestReleaseHooksUseAuthoritativeCountsAndFreezeOnlyAfterAllSteps(t *testing.T) {
	committed := false
	deliveryStub := &releaseDeliveryStub{result: delivery.DeliverySummary{Sent: 0, Failed: 99, Skipped: 0}}
	readerStub := &releaseReaderStub{summary: releaseHookPublication()}
	finalizerStub := &releaseFinalizerStub{outcome: interactions.CommandOutcome{OK: true, ResultFinalized: true}}
	serviceStub := interactionHookStub{committed: &committed, command: interactions.CommandOutcome{OK: true, Result: releaseHookResult()}}
	hook := InteractionHooks{InteractionService: serviceStub, Delivery: deliveryStub, Finalizer: finalizerStub, PublicationReader: readerStub, SpaceID: "space-fixture"}

	out, err := hook.ExecuteCommand(context.Background(), interactions.ExecuteCommandInput{Source: "/release 1.2.3", Request: interactions.Request{}})
	if err != nil || !out.OK || !out.ResultFinalized {
		t.Fatalf("outcome=%#v err=%v", out, err)
	}
	if !reflect.DeepEqual(deliveryStub.calls, []string{"delivery:1.2.3"}) || !reflect.DeepEqual(readerStub.calls, []string{"reader:1.2.3"}) || !reflect.DeepEqual(finalizerStub.calls, []string{"finalizer"}) {
		t.Fatalf("post-commit order delivery=%v reader=%v finalizer=%v", deliveryStub.calls, readerStub.calls, finalizerStub.calls)
	}
	if !deliveryStub.deadlineSet {
		t.Fatal("release post-commit work was not bounded")
	}
	if got := out.Result.(map[string]any); got["title"] != "Original title" || got["version"] != "1.2.3" || !reflect.DeepEqual(got["identity"], releaseHookResult()["identity"]) || got["recipientCount"] != int64(3) || got["pendingCount"] != int64(0) || got["sentCount"] != int64(2) || got["failedCount"] != int64(1) {
		t.Fatalf("merged release result=%#v", got)
	}
	if finalizerStub.input.Execution.Source != "/release 1.2.3" || !finalizerStub.input.Original.OK {
		t.Fatalf("finalizer binding=%#v", finalizerStub.input)
	}
}

func TestReleaseHooksAcceptExistingFrozenCountsFromConcurrentFinalizer(t *testing.T) {
	committed := false
	deliveryStub := &releaseDeliveryStub{}
	readerStub := &releaseReaderStub{summary: releaseHookPublication()}
	frozenResult := releaseHookResult()
	frozenResult["pendingCount"] = int64(1)
	frozenResult["sentCount"] = int64(1)
	frozenResult["failedCount"] = int64(1)
	finalizerStub := &releaseFinalizerStub{outcome: interactions.CommandOutcome{OK: true, Result: frozenResult, ResultFinalized: true}}
	original := interactions.CommandOutcome{OK: true, Result: releaseHookResult()}
	serviceStub := interactionHookStub{committed: &committed, command: original}
	hook := InteractionHooks{InteractionService: serviceStub, Delivery: deliveryStub, Finalizer: finalizerStub, PublicationReader: readerStub, SpaceID: "space-fixture"}

	out, err := hook.ExecuteCommand(context.Background(), interactions.ExecuteCommandInput{})
	if err != nil || !out.OK || !out.ResultFinalized {
		t.Fatalf("frozen concurrent outcome=%#v err=%v", out, err)
	}
	got, ok := out.Result.(map[string]any)
	if !ok {
		t.Fatalf("frozen concurrent result=%#v, want object", out.Result)
	}
	if got["pendingCount"] != int64(1) || got["sentCount"] != int64(1) || got["failedCount"] != int64(1) || got["recipientCount"] != int64(3) {
		t.Fatalf("frozen concurrent counts=%#v", got)
	}
	readResult, ok := finalizerStub.input.Result.(map[string]any)
	if !ok || readResult["pendingCount"] != int64(0) || readResult["sentCount"] != int64(2) || readResult["failedCount"] != int64(1) {
		t.Fatalf("local publication snapshot=%#v", finalizerStub.input.Result)
	}
}

func TestReleaseHooksDoNotSyncFrozenReplay(t *testing.T) {
	committed := false
	deliveryStub := &releaseDeliveryStub{}
	readerStub := &releaseReaderStub{summary: releaseHookPublication()}
	finalizerStub := &releaseFinalizerStub{outcome: interactions.CommandOutcome{OK: true, ResultFinalized: true}}
	serviceStub := interactionHookStub{committed: &committed, command: interactions.CommandOutcome{OK: true, Replayed: true, ResultFinalized: true, Result: releaseHookResult()}}
	hook := InteractionHooks{InteractionService: serviceStub, Delivery: deliveryStub, Finalizer: finalizerStub, PublicationReader: readerStub, SpaceID: "space-fixture"}

	out, err := hook.ExecuteCommand(context.Background(), interactions.ExecuteCommandInput{})
	if err != nil || !out.Replayed || !out.ResultFinalized || len(deliveryStub.calls) != 0 || len(readerStub.calls) != 0 || len(finalizerStub.calls) != 0 {
		t.Fatalf("frozen replay outcome=%#v err=%v delivery=%v reader=%v finalizer=%v", out, err, deliveryStub.calls, readerStub.calls, finalizerStub.calls)
	}
}

func TestReleaseHooksRetainSuccessOnPostCommitFailureAndRetryableState(t *testing.T) {
	for _, test := range []struct {
		name           string
		deliveryError  error
		readerError    error
		finalizerError error
		wantReader     bool
		wantFinalizer  bool
	}{
		{name: "delivery", deliveryError: errors.New("delivery unavailable")},
		{name: "publication reader", readerError: errors.New("reader unavailable"), wantReader: true},
		{name: "finalizer", finalizerError: errors.New("finalizer unavailable"), wantReader: true, wantFinalizer: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			committed := false
			deliveryStub := &releaseDeliveryStub{err: test.deliveryError}
			readerStub := &releaseReaderStub{summary: releaseHookPublication(), err: test.readerError}
			finalizerStub := &releaseFinalizerStub{err: test.finalizerError, outcome: interactions.CommandOutcome{OK: true, ResultFinalized: true}}
			originalResult := releaseHookResult()
			original := interactions.CommandOutcome{OK: true, Result: originalResult}
			serviceStub := interactionHookStub{committed: &committed, command: original}
			hook := InteractionHooks{InteractionService: serviceStub, Delivery: deliveryStub, Finalizer: finalizerStub, PublicationReader: readerStub, SpaceID: "space-fixture"}

			out, err := hook.ExecuteCommand(context.Background(), interactions.ExecuteCommandInput{})
			if err != nil || !out.OK || out.ResultFinalized {
				t.Fatalf("failure preserved outcome=%#v err=%v", out, err)
			}
			if !reflect.DeepEqual(out.Result, originalResult) {
				t.Fatalf("failure changed result=%#v want=%#v", out.Result, originalResult)
			}
			if test.wantReader != (len(readerStub.calls) == 1) || test.wantFinalizer != (len(finalizerStub.calls) == 1) {
				t.Fatalf("failure call state reader=%v finalizer=%v", readerStub.calls, finalizerStub.calls)
			}
		})
	}
}

func TestReleaseHooksRejectInvalidSummaryOrFinalizerIdentityMutation(t *testing.T) {
	tests := []struct {
		name         string
		summary      *releases.PublicationSummary
		mutate       bool
		mutateCounts bool
	}{
		{name: "version mismatch", summary: &releases.PublicationSummary{ID: "pub", Version: "9.9.9", RecipientCount: 1, SentCount: 1}},
		{name: "negative count", summary: &releases.PublicationSummary{ID: "pub", Version: "1.2.3", RecipientCount: 1, SentCount: -1}},
		{name: "inconsistent counts", summary: &releases.PublicationSummary{ID: "pub", Version: "1.2.3", RecipientCount: 2, SentCount: 1}},
		{name: "finalizer identity mutation", summary: releaseHookPublication(), mutate: true},
		{name: "finalizer count mutation", summary: releaseHookPublication(), mutate: true, mutateCounts: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			committed := false
			deliveryStub := &releaseDeliveryStub{}
			readerStub := &releaseReaderStub{summary: test.summary}
			finalizerStub := &releaseFinalizerStub{outcome: interactions.CommandOutcome{OK: true, ResultFinalized: true}}
			originalResult := releaseHookResult()
			original := interactions.CommandOutcome{OK: true, Result: originalResult}
			if test.mutate {
				finalizerStub.outcome.Result = map[string]any{"type": "release-published", "version": "1.2.3", "title": "forged"}
				if test.mutateCounts {
					mutated := releaseHookResult()
					mutated["sentCount"] = int64(99)
					finalizerStub.outcome.Result = mutated
				}
			}
			serviceStub := interactionHookStub{committed: &committed, command: original}
			hook := InteractionHooks{InteractionService: serviceStub, Delivery: deliveryStub, Finalizer: finalizerStub, PublicationReader: readerStub, SpaceID: "space-fixture"}

			out, err := hook.ExecuteCommand(context.Background(), interactions.ExecuteCommandInput{})
			if err != nil || !out.OK || out.ResultFinalized || len(finalizerStub.calls) != boolToInt(test.mutate) {
				t.Fatalf("invalid post-commit outcome=%#v err=%v finalizer=%v", out, err, finalizerStub.calls)
			}
			if !reflect.DeepEqual(out.Result, originalResult) {
				t.Fatalf("invalid post-commit changed result=%#v want=%#v", out.Result, originalResult)
			}
		})
	}
}

func TestReleaseCountHelpersUseJavaScriptSafeIntegerBoundary(t *testing.T) {
	const max = int64(9007199254740991)
	for _, field := range releaseCountFields {
		t.Run("result/"+field, func(t *testing.T) {
			valid := releaseResultBoundaryObject(field, max)
			if !validReleaseResultCounts(valid) {
				t.Fatalf("valid result boundary for %s rejected: %#v", field, valid)
			}
			over := releaseResultBoundaryObject(field, max+1)
			if validReleaseResultCounts(over) {
				t.Fatalf("over-boundary result for %s accepted: %#v", field, over)
			}
		})
		t.Run("summary/"+field, func(t *testing.T) {
			valid := releaseSummaryBoundaryObject(field, max)
			if !validReleasePublicationSummary(valid, "1.2.3") {
				t.Fatalf("valid summary boundary for %s rejected: %#v", field, valid)
			}
			over := releaseSummaryBoundaryObject(field, max+1)
			if validReleasePublicationSummary(over, "1.2.3") {
				t.Fatalf("over-boundary summary for %s accepted: %#v", field, over)
			}
		})
	}

	const safe = uint64(9007199254740991)
	for _, test := range []struct {
		name  string
		value any
		want  bool
	}{
		{name: "int max", value: int(safe), want: true},
		{name: "uint max", value: uint(safe), want: true},
		{name: "int64 max", value: int64(safe), want: true},
		{name: "uint64 max", value: uint64(safe), want: true},
		{name: "float64 max", value: float64(safe), want: true},
		{name: "json number max", value: json.Number(strconv.FormatUint(safe, 10)), want: true},
		{name: "int over", value: int(safe + 1), want: false},
		{name: "uint over", value: uint(safe + 1), want: false},
		{name: "int64 over", value: int64(safe + 1), want: false},
		{name: "uint64 over", value: uint64(safe + 1), want: false},
		{name: "float64 over", value: float64(safe + 1), want: false},
		{name: "json number over", value: json.Number(strconv.FormatUint(safe+1, 10)), want: false},
	} {
		t.Run("value/"+test.name, func(t *testing.T) {
			_, got := safeReleaseResultCount(test.value)
			if got != test.want {
				t.Fatalf("safeReleaseResultCount(%#v) = %v, want %v", test.value, got, test.want)
			}
		})
	}
}

func releaseResultBoundaryObject(field string, value int64) map[string]any {
	result := map[string]any{
		"type":           "release-published",
		"recipientCount": int64(0),
		"pendingCount":   int64(0),
		"sentCount":      int64(0),
		"failedCount":    int64(0),
		"skippedCount":   int64(0),
	}
	result[field] = value
	if field == "recipientCount" {
		result["sentCount"] = value
	} else {
		result["recipientCount"] = value
	}
	return result
}

func releaseSummaryBoundaryObject(field string, value int64) *releases.PublicationSummary {
	summary := &releases.PublicationSummary{ID: "boundary", Version: "1.2.3"}
	switch field {
	case "recipientCount":
		summary.RecipientCount = value
		summary.SentCount = value
	case "pendingCount":
		summary.RecipientCount = value
		summary.PendingCount = value
	case "sentCount":
		summary.RecipientCount = value
		summary.SentCount = value
	case "failedCount":
		summary.RecipientCount = value
		summary.FailedCount = value
	case "skippedCount":
		summary.RecipientCount = value
		summary.SkippedCount = value
	}
	return summary
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
