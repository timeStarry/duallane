package main

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/carddefinitions"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/delivery"
)

type echoFakeCall struct {
	options delivery.ProcessOptions
}

type echoFakeProcessor struct {
	mu      sync.Mutex
	calls   []echoFakeCall
	process func(context.Context, delivery.ProcessOptions, int) (delivery.ProcessReport, error)
}

func (f *echoFakeProcessor) ProcessJobsWithOptions(ctx context.Context, options delivery.ProcessOptions) (delivery.ProcessReport, error) {
	f.mu.Lock()
	callIndex := len(f.calls)
	f.calls = append(f.calls, echoFakeCall{options: options})
	f.mu.Unlock()
	if f.process == nil {
		return delivery.ProcessReport{Next: options.Cursor}, nil
	}
	return f.process(ctx, options, callIndex)
}

func (f *echoFakeProcessor) snapshotCalls() []echoFakeCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]echoFakeCall(nil), f.calls...)
}

type echoMemberPageCall struct {
	spaceID string
	after   string
	limit   int
}

type echoMemberSourceFake struct {
	mu    sync.Mutex
	calls []echoMemberPageCall
	page  func(context.Context, string, string, int, int) ([]string, error)
}

func (f *echoMemberSourceFake) ListActiveHumanMembersAfter(ctx context.Context, spaceID, afterID string, limit int) ([]string, error) {
	f.mu.Lock()
	callIndex := len(f.calls)
	f.calls = append(f.calls, echoMemberPageCall{spaceID: spaceID, after: afterID, limit: limit})
	f.mu.Unlock()
	if f.page == nil {
		return nil, nil
	}
	return f.page(ctx, spaceID, afterID, limit, callIndex)
}

func (f *echoMemberSourceFake) snapshotCalls() []echoMemberPageCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]echoMemberPageCall(nil), f.calls...)
}

type echoMemberSyncCall struct {
	spaceID string
	member  string
}

type echoMemberReconcilerFake struct {
	mu    sync.Mutex
	calls []echoMemberSyncCall
	sync  func(context.Context, string, string, auth.RequestMeta, int) (delivery.MemberSyncResult, error)
}

func (f *echoMemberReconcilerFake) SyncMember(ctx context.Context, spaceID, memberID string, meta auth.RequestMeta) (delivery.MemberSyncResult, error) {
	f.mu.Lock()
	callIndex := len(f.calls)
	f.calls = append(f.calls, echoMemberSyncCall{spaceID: spaceID, member: memberID})
	f.mu.Unlock()
	if f.sync == nil {
		return delivery.MemberSyncResult{}, nil
	}
	return f.sync(ctx, spaceID, memberID, meta, callIndex)
}

func (f *echoMemberReconcilerFake) snapshotCalls() []echoMemberSyncCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]echoMemberSyncCall(nil), f.calls...)
}

func echoMemberIDs(count int) []string {
	values := make([]string, count)
	for index := range values {
		values[index] = fmt.Sprintf("member-%02d", index)
	}
	return values
}

func TestEchoProcessorFamilyCursorsAreIndependentAndBounded(t *testing.T) {
	fake := &echoFakeProcessor{
		process: func(_ context.Context, options delivery.ProcessOptions, _ int) (delivery.ProcessReport, error) {
			next := options.Cursor
			switch options.Family {
			case delivery.DeliveryTypeSolicitation:
				next.Solicitation = "sol-after-page"
			case delivery.DeliveryTypeRequirement:
				next.Requirement = "req-after-page"
			case delivery.DeliveryTypeRelease:
				next.Release = "rel-after-page"
			}
			return delivery.ProcessReport{Next: next}, nil
		},
	}
	solicitation := newEchoProcessor("sol", delivery.DeliveryTypeSolicitation, fake)
	requirement := newEchoProcessor("req", delivery.DeliveryTypeRequirement, fake)
	release := newEchoProcessor("rel", delivery.DeliveryTypeRelease, fake)

	for _, processor := range []workerProcessor{solicitation, requirement, release} {
		if processor.interval != echoWorkerInterval {
			t.Fatalf("processor interval = %s, want %s", processor.interval, echoWorkerInterval)
		}
		if _, err := processor.process(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := solicitation.process(context.Background()); err != nil {
		t.Fatal(err)
	}

	calls := fake.snapshotCalls()
	if len(calls) != 4 {
		t.Fatalf("processor calls = %d, want 4", len(calls))
	}
	if got := calls[0].options; got.Family != delivery.DeliveryTypeSolicitation || got.Limit != echoWorkerBatchLimit || got.RequirementLimit != echoWorkerRequirementLimit || got.Cursor != (delivery.WorkCursor{}) {
		t.Fatalf("first solicitation options = %+v", got)
	}
	if got := calls[1].options; got.Family != delivery.DeliveryTypeRequirement || got.Cursor != (delivery.WorkCursor{}) {
		t.Fatalf("first requirement options = %+v", got)
	}
	if got := calls[2].options; got.Family != delivery.DeliveryTypeRelease || got.Cursor != (delivery.WorkCursor{}) {
		t.Fatalf("first release options = %+v", got)
	}
	if got := calls[3].options; got.Family != delivery.DeliveryTypeSolicitation || got.Cursor != (delivery.WorkCursor{Solicitation: "sol-after-page"}) {
		t.Fatalf("second solicitation options = %+v", got)
	}
}

func TestEchoProcessorCancellationDoesNotAdvanceCursor(t *testing.T) {
	first := true
	fake := &echoFakeProcessor{
		process: func(_ context.Context, options delivery.ProcessOptions, _ int) (delivery.ProcessReport, error) {
			next := options.Cursor
			next.Solicitation = "must-not-be-retained"
			if first {
				first = false
				return delivery.ProcessReport{Next: next}, context.Canceled
			}
			return delivery.ProcessReport{Next: next}, nil
		},
	}
	processor := newEchoProcessor("sol", delivery.DeliveryTypeSolicitation, fake)
	result, err := processor.process(context.Background())
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("first error = %v, want cancellation", err)
	}
	if result.Cancelled != 1 {
		t.Fatalf("first result = %+v, want one cancellation", result)
	}
	if _, err := processor.process(context.Background()); err != nil {
		t.Fatal(err)
	}
	calls := fake.snapshotCalls()
	if len(calls) != 2 || calls[1].options.Cursor != (delivery.WorkCursor{}) {
		t.Fatalf("cursor after cancellation = %+v, want empty; calls=%+v", calls, calls)
	}
}

func TestEchoProcessorOrdinaryErrorDiscardsReturnedCursor(t *testing.T) {
	marker := errors.New("synthetic row failure")
	fake := &echoFakeProcessor{
		process: func(_ context.Context, options delivery.ProcessOptions, callIndex int) (delivery.ProcessReport, error) {
			next := options.Cursor
			next.Release = "release-after-error"
			if callIndex == 0 {
				return delivery.ProcessReport{
					Releases: []delivery.DeliveryResult{{Status: delivery.DeliveryFailed, DeliveryID: "opaque"}},
					Next:     next,
				}, marker
			}
			return delivery.ProcessReport{Next: next}, nil
		},
	}
	processor := newEchoProcessor("rel", delivery.DeliveryTypeRelease, fake)
	result, err := processor.process(context.Background())
	if !errors.Is(err, marker) {
		t.Fatalf("first error = %v, want marker", err)
	}
	if result.Claimed != 1 || result.Failed != 1 || result.Sent != 0 {
		t.Fatalf("first result = %+v", result)
	}
	if _, err := processor.process(context.Background()); err != nil {
		t.Fatal(err)
	}
	calls := fake.snapshotCalls()
	if len(calls) != 2 || calls[1].options.Cursor != (delivery.WorkCursor{}) {
		t.Fatalf("cursor after ordinary error = %+v, want empty cursor", calls)
	}
}

func TestEchoMemberReconciliationIsKeysetBoundedAndDoesNotPublishRelease(t *testing.T) {
	members := echoMemberIDs(echoMemberReconciliationLimit)
	source := &echoMemberSourceFake{
		page: func(_ context.Context, _ string, afterID string, _ int, callIndex int) ([]string, error) {
			switch {
			case callIndex == 0 && afterID == "":
				return members, nil
			case callIndex == 1 && afterID == "member-24":
				return []string{"member-25"}, nil
			case callIndex == 2 && afterID == "":
				return nil, nil
			default:
				return nil, fmt.Errorf("unexpected member page call %d after %q", callIndex, afterID)
			}
		},
	}
	reconciler := &echoMemberReconcilerFake{
		sync: func(_ context.Context, _ string, _ string, _ auth.RequestMeta, _ int) (delivery.MemberSyncResult, error) {
			return delivery.MemberSyncResult{
				Solicitations: []delivery.DeliveryResult{{Status: delivery.DeliverySent}},
				// SyncMember does not publish releases. A future accidental
				// field population must not create a second release path here.
				Releases: []delivery.DeliveryResult{{Status: delivery.DeliverySent}},
			}, nil
		},
	}
	processor := newEchoMemberReconciliationProcessor("member", "spc-test", source, reconciler)
	first, err := processor.process(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if first != (processResult{Claimed: 25, Sent: 25}) {
		t.Fatalf("first member cycle = %+v", first)
	}
	second, err := processor.process(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if second != (processResult{Claimed: 1, Sent: 1}) {
		t.Fatalf("second member cycle = %+v", second)
	}
	third, err := processor.process(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if third != (processResult{}) {
		t.Fatalf("wrap member cycle = %+v", third)
	}

	pageCalls := source.snapshotCalls()
	if len(pageCalls) != 3 {
		t.Fatalf("member page calls = %d, want 3", len(pageCalls))
	}
	for index, call := range pageCalls {
		if call.limit != echoMemberReconciliationLimit {
			t.Fatalf("page %d limit = %d, want %d", index, call.limit, echoMemberReconciliationLimit)
		}
		if call.spaceID != "spc-test" {
			t.Fatalf("page %d space = %q, want spc-test", index, call.spaceID)
		}
	}
	if got := reconciler.snapshotCalls(); len(got) != 26 {
		t.Fatalf("member sync calls = %d, want 26", len(got))
	}
	syncCalls := reconciler.snapshotCalls()
	if syncCalls[0].spaceID != "spc-test" || syncCalls[0].member != "member-00" || syncCalls[25].member != "member-25" {
		t.Fatalf("member sync call boundaries = %+v", syncCalls)
	}
}

func TestEchoMemberReconciliationOrdinaryErrorDiscardsCursorAndContinuesPage(t *testing.T) {
	marker := errors.New("synthetic member dependency failure")
	members := echoMemberIDs(echoMemberReconciliationLimit)
	source := &echoMemberSourceFake{
		page: func(_ context.Context, _ string, afterID string, _ int, callIndex int) ([]string, error) {
			if callIndex == 0 && afterID == "" {
				return members, nil
			}
			if callIndex == 1 && afterID == "" {
				return nil, nil
			}
			return nil, fmt.Errorf("unexpected member page call %d after %q", callIndex, afterID)
		},
	}
	reconciler := &echoMemberReconcilerFake{
		sync: func(_ context.Context, _ string, memberID string, _ auth.RequestMeta, _ int) (delivery.MemberSyncResult, error) {
			if memberID == "member-07" {
				return delivery.MemberSyncResult{}, marker
			}
			return delivery.MemberSyncResult{
				Solicitations: []delivery.DeliveryResult{{Status: delivery.DeliverySent}},
			}, nil
		},
	}
	processor := newEchoMemberReconciliationProcessor("member", "spc-test", source, reconciler)
	first, err := processor.process(context.Background())
	if !errors.Is(err, marker) {
		t.Fatalf("first member error = %v, want marker", err)
	}
	if first.Claimed != echoMemberReconciliationLimit || first.Sent != echoMemberReconciliationLimit-1 || first.Failed != 1 || first.Cancelled != 0 {
		t.Fatalf("first member result = %+v", first)
	}
	if got := reconciler.snapshotCalls(); len(got) != echoMemberReconciliationLimit {
		t.Fatalf("member calls after ordinary error = %d, want %d", len(got), echoMemberReconciliationLimit)
	}
	if _, err := processor.process(context.Background()); err != nil {
		t.Fatal(err)
	}
	pageCalls := source.snapshotCalls()
	if len(pageCalls) != 2 || pageCalls[1].after != "" {
		t.Fatalf("cursor after ordinary error = %+v, want empty cursor on retry", pageCalls)
	}
}

func TestEchoMemberReconciliationCancellationDoesNotAdvanceCursor(t *testing.T) {
	members := echoMemberIDs(echoMemberReconciliationLimit)
	source := &echoMemberSourceFake{
		page: func(_ context.Context, _ string, afterID string, _ int, callIndex int) ([]string, error) {
			if callIndex == 0 && afterID == "" {
				return members, nil
			}
			if callIndex == 1 && afterID == "" {
				return nil, nil
			}
			return nil, fmt.Errorf("unexpected member page call %d after %q", callIndex, afterID)
		},
	}
	reconciler := &echoMemberReconcilerFake{
		sync: func(_ context.Context, _ string, _ string, _ auth.RequestMeta, callIndex int) (delivery.MemberSyncResult, error) {
			if callIndex == 0 {
				return delivery.MemberSyncResult{}, context.Canceled
			}
			return delivery.MemberSyncResult{}, nil
		},
	}
	processor := newEchoMemberReconciliationProcessor("member", "spc-test", source, reconciler)
	first, err := processor.process(context.Background())
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("first member error = %v, want cancellation", err)
	}
	if first.Claimed != 1 || first.Cancelled != 1 || first.Failed != 0 {
		t.Fatalf("first member result = %+v", first)
	}
	if _, err := processor.process(context.Background()); err != nil {
		t.Fatal(err)
	}
	pageCalls := source.snapshotCalls()
	if len(pageCalls) != 2 || pageCalls[1].after != "" {
		t.Fatalf("cursor after cancellation = %+v, want empty cursor on retry", pageCalls)
	}
}

func TestEchoMemberReconciliationTimeoutIsBounded(t *testing.T) {
	source := &echoMemberSourceFake{
		page: func(ctx context.Context, _ string, _ string, _ int, _ int) ([]string, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		},
	}
	reconciler := &echoMemberReconcilerFake{}
	processor := newEchoMemberReconciliationProcessorWithTimeout(
		"member", "spc-test", source, reconciler, 10*time.Millisecond,
	)
	result, err := processor.process(context.Background())
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("timeout error = %v, want deadline exceeded", err)
	}
	if result.Cancelled != 1 || result.Claimed != 0 {
		t.Fatalf("timeout result = %+v", result)
	}
	if got := reconciler.snapshotCalls(); len(got) != 0 {
		t.Fatalf("member sync calls after source timeout = %d, want 0", len(got))
	}
}

func TestEchoProcessResultContainsOnlyCounters(t *testing.T) {
	solicitation := echoProcessResult(delivery.ProcessReport{
		Solicitations: []delivery.DeliveryResult{
			{Status: delivery.DeliverySent, DeliveryID: "secret-delivery", RecipientUserID: "secret-recipient", CardID: "secret-card", MessageID: "secret-message"},
			{Status: delivery.DeliveryFailed, ErrorCode: "secret-error"},
			{Status: delivery.DeliverySkipped},
		},
	}, delivery.DeliveryTypeSolicitation, false)
	if solicitation != (processResult{Claimed: 3, Sent: 1, Failed: 1, Cancelled: 0, Retried: 0}) {
		t.Fatalf("solicitation counters = %+v", solicitation)
	}
	requirement := echoProcessResult(delivery.ProcessReport{
		Requirements: []delivery.DeliverySummary{
			{Key: "secret-requirement", Results: []delivery.DeliveryResult{{RecipientUserID: "secret-recipient"}}, Sent: 2, Failed: 1},
			{Skipped: 1},
		},
	}, delivery.DeliveryTypeRequirement, true)
	if requirement != (processResult{Claimed: 2, Sent: 2, Failed: 1, Cancelled: 1, Retried: 0}) {
		t.Fatalf("requirement counters = %+v", requirement)
	}
	if reflect.TypeOf(solicitation).NumField() != 5 {
		t.Fatal("worker result unexpectedly grew a payload-bearing field")
	}
}

func TestEchoWorkerComposesFiveEchoCardDefinitions(t *testing.T) {
	registry, err := carddefinitions.NewRegistry(carddefinitions.Options{})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"echo.release@1",
		"echo.request-list@1",
		"echo.request-status@1",
		"echo.request@1",
		"echo.solicitation@1",
	}
	if got := registry.Types(); !reflect.DeepEqual(got, want) {
		t.Fatalf("Echo registry types = %#v, want %#v", got, want)
	}
}

func TestNewEchoProcessorsHonorsWorkspaceGateAndRequiresPoolWhenEnabled(t *testing.T) {
	processors, err := newEchoProcessors(nil, &config.WorkspaceConfig{Enabled: false})
	if err != nil {
		t.Fatal(err)
	}
	if len(processors) != 0 {
		t.Fatalf("disabled Echo processors = %d, want zero", len(processors))
	}
	if _, err := newEchoProcessors(nil, &config.WorkspaceConfig{Enabled: true}); err == nil {
		t.Fatal("enabled Echo composition accepted a nil PostgreSQL pool")
	}
}
