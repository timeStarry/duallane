package runtime

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/delivery"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/releases"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/interactions"
)

// A replay can observe a pending recipient while the original request owns
// its delivery claim. Freezing that result must not make client cancellation
// abandon the already-committed publication's only active delivery attempt.
type releaseCancellationFixture struct {
	InteractionService
	DeliveryHooks
	entered chan struct{}
	resume  chan struct{}
	calls   atomic.Int32
	sent    atomic.Int32
	mu      sync.Mutex
	frozen  *interactions.CommandOutcome
}

func (f *releaseCancellationFixture) ExecuteCommand(_ context.Context, _ interactions.ExecuteCommandInput) (interactions.CommandOutcome, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.frozen != nil {
		value := *f.frozen
		value.Replayed = true
		return value, nil
	}
	return interactions.CommandOutcome{OK: true, Result: map[string]any{
		"type": "release-published", "version": "1.2.3", "recipientCount": int64(1),
		"pendingCount": int64(1), "sentCount": int64(0), "failedCount": int64(0), "skippedCount": int64(0),
	}}, nil
}

func (f *releaseCancellationFixture) SyncRelease(ctx context.Context, _ delivery.SyncInput) (delivery.DeliverySummary, error) {
	if f.calls.Add(1) != 1 {
		// The concurrent replay cannot claim the row owned by the first call.
		return delivery.DeliverySummary{}, nil
	}
	close(f.entered)
	<-f.resume
	if err := ctx.Err(); err != nil {
		return delivery.DeliverySummary{}, err
	}
	f.sent.Add(1)
	return delivery.DeliverySummary{Sent: 1}, nil
}

func (f *releaseCancellationFixture) GetPublication(ctx context.Context, _ string) (*releases.PublicationSummary, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	sent := int64(f.sent.Load())
	return &releases.PublicationSummary{ID: "release-fixture", Version: "1.2.3", RecipientCount: 1, SentCount: sent, PendingCount: 1 - sent}, nil
}

func (f *releaseCancellationFixture) FinalizeCommandResult(ctx context.Context, input interactions.FinalizeCommandResultInput) (interactions.CommandOutcome, error) {
	if err := ctx.Err(); err != nil {
		return interactions.CommandOutcome{}, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.frozen == nil {
		value := input.Original
		value.Result, value.ResultFinalized = input.Result, true
		f.frozen = &value
	}
	value := *f.frozen
	value.Replayed = input.Original.Replayed
	return value, nil
}

func TestReleaseCommittedDeliverySurvivesCancelledRequestAfterConcurrentReplay(t *testing.T) {
	fixture := &releaseCancellationFixture{entered: make(chan struct{}), resume: make(chan struct{})}
	hook := InteractionHooks{InteractionService: fixture, Delivery: fixture, PublicationReader: fixture, Finalizer: fixture}
	request, cancel := context.WithCancel(context.Background())
	defer cancel()
	finished := make(chan error, 1)
	go func() {
		_, err := hook.ExecuteCommand(request, interactions.ExecuteCommandInput{})
		finished <- err
	}()
	<-fixture.entered
	var resume sync.Once
	defer resume.Do(func() { close(fixture.resume) })

	replayed, err := hook.ExecuteCommand(context.Background(), interactions.ExecuteCommandInput{})
	if err != nil || !replayed.OK || !replayed.ResultFinalized || replayed.Result.(map[string]any)["pendingCount"] != int64(1) {
		t.Fatalf("concurrent replay did not retain the pending publication: err=%v", err)
	}
	cancel()
	resume.Do(func() { close(fixture.resume) })
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	if fixture.sent.Load() != 1 {
		t.Fatal("client cancellation abandoned the committed publication after replay froze its pending result")
	}
	if _, err := hook.ExecuteCommand(context.Background(), interactions.ExecuteCommandInput{}); err != nil || fixture.calls.Load() != 2 {
		t.Fatal("frozen replay attempted another delivery")
	}
}

type releaseContextProbe struct {
	DeliveryHooks
	check func(context.Context)
}

func (p releaseContextProbe) SyncRelease(ctx context.Context, _ delivery.SyncInput) (delivery.DeliverySummary, error) {
	p.check(ctx)
	return delivery.DeliverySummary{}, ctx.Err()
}

type releaseContextKey struct{}

func TestReleasePostCommitCancellationDoesNotExtendDeadlines(t *testing.T) {
	for _, scenario := range []string{"default bound", "earlier request deadline", "expired request deadline"} {
		t.Run(scenario, func(t *testing.T) {
			parent := context.WithValue(context.Background(), releaseContextKey{}, "fixture")
			var deadline time.Time
			var cancelDeadline context.CancelFunc
			if scenario != "default bound" {
				deadline = time.Now().Add(time.Second)
				if scenario == "expired request deadline" {
					deadline = time.Now().Add(-time.Second)
				}
				parent, cancelDeadline = context.WithDeadline(parent, deadline)
				defer cancelDeadline()
			}
			request, cancel := context.WithCancel(parent)
			cancel()
			committed := false
			called := false
			started := time.Now()
			hook := InteractionHooks{
				InteractionService: interactionHookStub{committed: &committed, command: interactions.CommandOutcome{OK: true, Result: releaseHookResult()}},
				Delivery: releaseContextProbe{check: func(ctx context.Context) {
					called = true
					if !committed || ctx.Value(releaseContextKey{}) != "fixture" {
						t.Fatal("post-commit context lost its boundary or request values")
					}
					bound, ok := ctx.Deadline()
					if !ok || bound.Before(started) && scenario != "expired request deadline" || bound.After(time.Now().Add(releasePostCommitTimeout)) {
						t.Fatal("post-commit work has an invalid time bound")
					}
					if !deadline.IsZero() && !bound.Equal(deadline) {
						t.Fatal("post-commit work extended the original request deadline")
					}
					if scenario == "expired request deadline" {
						if ctx.Err() != context.DeadlineExceeded {
							t.Fatal("expired deadline was not retained")
						}
					} else if ctx.Err() != nil {
						t.Fatal("client cancellation escaped into committed release delivery")
					}
				}},
			}
			if _, err := hook.ExecuteCommand(request, interactions.ExecuteCommandInput{}); err != nil || !called {
				t.Fatalf("post-commit probe did not execute: err=%v", err)
			}
		})
	}
}
