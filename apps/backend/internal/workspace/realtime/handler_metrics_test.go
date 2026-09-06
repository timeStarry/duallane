package realtime

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	workspaceEvents "github.com/timestarry/duallane/apps/backend/internal/workspace/events"
)

type realtimeMetricsRecorder struct {
	mu          sync.Mutex
	connections int64
	deltas      []int64
	replays     []realtimeReplayObservation
	lags        []time.Duration
	durations   []time.Duration
}

type realtimeReplayObservation struct {
	events       int64
	syncRequired bool
}

func (r *realtimeMetricsRecorder) AddWorkspaceWebSocketConnections(delta int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.connections += delta
	r.deltas = append(r.deltas, delta)
}

func (r *realtimeMetricsRecorder) ObserveWorkspaceWebSocketReplay(events int64, syncRequired bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.replays = append(r.replays, realtimeReplayObservation{events: events, syncRequired: syncRequired})
}

func (r *realtimeMetricsRecorder) ObserveWorkspaceWebSocketReplayLag(lag time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lags = append(r.lags, lag)
}

func (r *realtimeMetricsRecorder) ObserveWorkspaceWebSocketReplayDuration(duration time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.durations = append(r.durations, duration)
}

func (r *realtimeMetricsRecorder) snapshot() (int64, []int64, []realtimeReplayObservation) {
	r.mu.Lock()
	defer r.mu.Unlock()
	deltas := append([]int64(nil), r.deltas...)
	replays := append([]realtimeReplayObservation(nil), r.replays...)
	return r.connections, deltas, replays
}

func (r *realtimeMetricsRecorder) replayDetails() ([]time.Duration, []time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]time.Duration(nil), r.lags...), append([]time.Duration(nil), r.durations...)
}

func TestHandlerMetricsCountsOnlyAcceptedConnectionAndClosesOnce(t *testing.T) {
	recorder := &realtimeMetricsRecorder{}
	service := &fakeEventService{results: map[int64]workspaceEvents.ReplayResult{0: {CurrentSeq: 0, ReplayFrom: 1}}, errors: map[int64]error{}}
	server := httptest.NewServer(NewHandler(HandlerOptions{
		ActorResolver: &fakeResolver{actor: &auth.Actor{ID: "usr-viewer", Kind: "human", Role: "member"}},
		Events:        service, Metrics: recorder, PollInterval: time.Hour, HeartbeatInterval: time.Hour,
	}))
	defer server.Close()

	_, response, dialErr := websocket.Dial(context.Background(), websocketURL(server.URL), &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{"https://not-the-test-server.example"}},
	})
	if response != nil {
		_ = response.Body.Close()
	}
	if dialErr == nil {
		t.Fatal("cross-origin metrics test unexpectedly connected")
	}
	if connections, _, _ := recorder.snapshot(); connections != 0 {
		t.Fatalf("rejected connection changed gauge to %d", connections)
	}

	connection := dial(t, server.URL, nil)
	writeText(t, connection, `{"version":1,"type":"hello","lastSeq":0}`)
	_ = readFrame(t, connection)
	waitForRealtimeMetric(t, func() bool {
		connections, _, _ := recorder.snapshot()
		return connections == 1
	})
	if err := connection.CloseNow(); err != nil {
		t.Fatalf("close websocket: %v", err)
	}
	waitForRealtimeMetric(t, func() bool {
		connections, _, _ := recorder.snapshot()
		return connections == 0
	})
	// The handler owns one defer for the accepted connection. Waiting again
	// catches an accidental decrement on both read-loop and close paths.
	time.Sleep(25 * time.Millisecond)
	connections, deltas, _ := recorder.snapshot()
	if connections != 0 || len(deltas) != 2 || deltas[0] != 1 || deltas[1] != -1 {
		t.Fatalf("connection metrics connections=%d deltas=%v", connections, deltas)
	}
}

func TestHandlerMetricsRecordsReplayLatencyEventsAndExplicitSync(t *testing.T) {
	recorder := &realtimeMetricsRecorder{}
	hub := NewHub()
	service := &fakeEventService{results: map[int64]workspaceEvents.ReplayResult{}, errors: map[int64]error{}}
	service.set(0, workspaceEvents.ReplayResult{
		CurrentSeq: 2, ReplayFrom: 1, ReplayCount: 2,
		Events: []workspaceEvents.Event{event(1), event(2)},
	})
	server := httptest.NewServer(NewHandler(HandlerOptions{
		ActorResolver: &fakeResolver{actor: &auth.Actor{ID: "usr-viewer", Kind: "human", Role: "member"}},
		Events:        service, Hub: hub, Metrics: recorder, PollInterval: time.Hour, HeartbeatInterval: time.Hour,
	}))
	defer server.Close()
	connection := dial(t, server.URL, nil)
	defer connection.CloseNow()
	writeText(t, connection, `{"version":1,"type":"hello","lastSeq":0}`)
	_ = readFrame(t, connection)
	_ = readFrame(t, connection)
	_ = readFrame(t, connection)
	waitForRealtimeMetric(t, func() bool {
		_, _, replays := recorder.snapshot()
		return len(replays) == 1
	})
	_, _, replays := recorder.snapshot()
	lags, durations := recorder.replayDetails()
	if len(replays) != 1 || replays[0].events != 2 || replays[0].syncRequired || len(lags) != 1 || lags[0] <= 30*time.Second || len(durations) != 1 || durations[0] < 0 {
		t.Fatalf("initial replay metrics = %+v", replays)
	}

	service.set(2, workspaceEvents.ReplayResult{
		CurrentSeq: 3, ReplayFrom: 3, ReplayCount: 0,
		SyncRequired: true, Reason: workspaceEvents.SyncReasonCursorAhead,
	})
	hub.Notify()
	syncFrame := readFrame(t, connection)
	if syncFrame["type"] != "sync.required" {
		t.Fatalf("sync frame = %#v", syncFrame)
	}
	waitForRealtimeMetric(t, func() bool {
		_, _, current := recorder.snapshot()
		return len(current) == 2
	})
	_, _, replays = recorder.snapshot()
	lags, durations = recorder.replayDetails()
	if len(replays) != 2 || replays[1].events != 0 || !replays[1].syncRequired || len(lags) != 1 || len(durations) != 2 || durations[1] < 0 {
		t.Fatalf("sync replay metrics = %+v", replays)
	}

	service.set(3, workspaceEvents.ReplayResult{
		CurrentSeq: 4, ReplayFrom: 4, ReplayCount: 1, HasMore: true,
		Events: []workspaceEvents.Event{event(4)},
	})
	hub.Notify()
	if next := readFrame(t, connection); next["type"] != "event" {
		t.Fatalf("has-more event frame = %#v", next)
	}
	if next := readFrame(t, connection); next["type"] != "sync.required" {
		t.Fatalf("has-more sync frame = %#v", next)
	}
	waitForRealtimeMetric(t, func() bool {
		_, _, current := recorder.snapshot()
		return len(current) == 3
	})
	_, _, replays = recorder.snapshot()
	lags, durations = recorder.replayDetails()
	if len(replays) != 3 || !replays[2].syncRequired || len(lags) != 2 || len(durations) != 3 {
		t.Fatalf("has-more replay metrics = replays:%+v lags:%v durations:%v", replays, lags, durations)
	}
}

func TestOldestReplayEventAgeRequiresValidDurableTimestamp(t *testing.T) {
	now := time.Date(2026, time.September, 6, 12, 0, 0, 0, time.UTC)
	if _, ok := oldestReplayEventAge(now, nil); ok {
		t.Fatal("empty replay reported a lag sample")
	}
	if _, ok := oldestReplayEventAge(now, []workspaceEvents.Event{{CreatedAt: "not-a-timestamp"}}); ok {
		t.Fatal("invalid durable timestamp reported a lag sample")
	}
	age, ok := oldestReplayEventAge(now, []workspaceEvents.Event{
		{CreatedAt: now.Add(-2 * time.Minute).Format(time.RFC3339Nano)},
		{CreatedAt: now.Add(-10 * time.Minute).Format(time.RFC3339Nano)},
	})
	if !ok || age != 10*time.Minute {
		t.Fatalf("oldest replay age = %s, ok=%t", age, ok)
	}
}

func waitForRealtimeMetric(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("realtime metrics condition was not reached")
}
