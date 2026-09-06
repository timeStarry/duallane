package metrics

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	_ PGPoolStats           = (*pgxpool.Stat)(nil)
	_ PGPoolCumulativeStats = (*pgxpool.Stat)(nil)
)

const testRoute = "/api/workspace/messages/{messageId}"

func newTestMetrics(t *testing.T) *Metrics {
	t.Helper()
	m, err := New(Options{RouteTemplates: []string{testRoute, "/readyz"}})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return m
}

func scrapeMetrics(t *testing.T, m *Metrics) string {
	t.Helper()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	m.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("metrics status = %d, body = %q", recorder.Code, recorder.Body.String())
	}
	return recorder.Body.String()
}

func TestNewRejectsUnsafeRouteTemplateWithoutEchoingIt(t *testing.T) {
	unsafe := []string{
		"api/messages",
		"/api/messages?token=secret",
		"/api/messages/{user id}",
		"/api/messages/\u0085",
		"/api/messages/" + strings.Repeat("x", 513),
	}
	for _, route := range unsafe {
		_, err := New(Options{RouteTemplates: []string{route}})
		if err == nil {
			t.Fatalf("New(%q) accepted unsafe route", route)
		}
		if strings.Contains(err.Error(), route) {
			t.Fatalf("route validation error echoed input %q", route)
		}
	}
}

func TestHTTPUsesOnlyConfiguredRouteAndFixedLabels(t *testing.T) {
	m := newTestMetrics(t)
	m.ObserveHTTP(ServiceWorkspace, http.MethodGet, testRoute, http.StatusOK, 25*time.Millisecond)
	m.ObserveHTTP(ServiceWorkspace, http.MethodGet, "/api/workspace/messages/usr_secret?token=secret", http.StatusOK, -time.Second)
	m.ObserveHTTP(Service("private-service"), "TRACE", testRoute, 700, time.Second)

	body := scrapeMetrics(t, m)
	for _, want := range []string{
		`service="workspace"`,
		`method="GET"`,
		`route="` + testRoute + `"`,
		`status_class="2xx"`,
		`route="unknown"`,
		`service="other"`,
		`method="OTHER"`,
		`status_class="5xx"`,
		"duallane_workspace_http_request_duration_seconds_count",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("metrics body missing %q:\n%s", want, body)
		}
	}
	for _, forbidden := range []string{"usr_secret", "token=secret", "private-service"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("metrics body leaked %q:\n%s", forbidden, body)
		}
	}
}

func TestWorkspaceWebSocketAndPGPoolObservationsClampValues(t *testing.T) {
	m := newTestMetrics(t)
	m.SetWorkspaceWebSocketConnections(-2)
	m.AddWorkspaceWebSocketConnections(3)
	m.AddWorkspaceWebSocketConnections(-8)
	m.ObserveWorkspaceWebSocketReplay(3, true)
	m.ObserveWorkspaceWebSocketReplay(-1, false)
	m.ObserveWorkspaceWebSocketReplayLag(250 * time.Millisecond)
	m.ObserveWorkspaceWebSocketReplayDuration(10 * time.Millisecond)

	m.SetPGPool(ServiceWorkspace, PGPoolSnapshot{
		MaxConns: -1, TotalConns: 4, AcquiredConns: -2, IdleConns: 3, ConstructingConns: 1,
	})
	m.ObservePGPoolAcquire(ServiceWorkspace, PGPoolAcquireSuccess, 10*time.Millisecond)
	m.ObservePGPoolAcquire(Service("secret-service"), PGPoolAcquireOutcome("secret-outcome"), -time.Second)

	body := scrapeMetrics(t, m)
	for _, want := range []string{
		"duallane_workspace_websocket_connections 0",
		"duallane_workspace_websocket_replays_total 2",
		"duallane_workspace_websocket_replay_events_total 3",
		"duallane_workspace_websocket_sync_required_total 1",
		"duallane_workspace_websocket_replay_lag_seconds_count 1",
		"duallane_workspace_websocket_replay_duration_seconds_count 1",
		`duallane_workspace_postgres_pool_max_connections{service="workspace"} 0`,
		`duallane_workspace_postgres_pool_acquired_connections{service="workspace"} 0`,
		`outcome="success"`,
		`outcome="other"`,
		`service="other"`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("metrics body missing %q:\n%s", want, body)
		}
	}
}

func TestWorkerAndObjectObservationsUseFixedOperations(t *testing.T) {
	m := newTestMetrics(t)
	m.SetWorkerBacklog(WorkerOperationEchoSolicitationDelivery, WorkerBacklogSnapshot{
		Pending: 9, OldestAge: 2 * time.Second, OldestLeaseAge: -time.Second, LeaseAgeAvailable: true,
	})
	m.SetWorkerBacklog(WorkerOperation("job-with-user-secret"), WorkerBacklogSnapshot{Pending: 1})
	m.ObserveWorkerResult(WorkerOperationEchoSolicitationDelivery, WorkerResult{
		Eligible: 2, Claimed: 2, Completed: 1, Failed: 1, Cancelled: 1, Retried: 2, LeaseExpired: 1,
	})
	m.ObserveWorkerOutcome(WorkerOperation("job-with-user-secret"), WorkerResultKind("raw-infra-error"), 1)
	m.ObserveObject(ServiceWorkspace, ObjectOperationPut, ObjectOutcomeSuccess, 128)
	m.ObserveObject(Service("secret-service"), ObjectOperation("raw-object-key"), ObjectOutcome("raw-error"), -1)

	body := scrapeMetrics(t, m)
	for _, want := range []string{
		`operation="echo_solicitation_delivery"`,
		`operation="other"`,
		`result="completed"`,
		`result="other"`,
		`operation="put"`,
		`operation="other"`,
		`outcome="success"`,
		`outcome="other"`,
		"duallane_worker_backlog_age_seconds",
		"duallane_worker_lease_age_seconds",
		"duallane_workspace_object_bytes_total",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("metrics body missing %q:\n%s", want, body)
		}
	}
	for _, forbidden := range []string{"job-with-user-secret", "raw-infra-error", "raw-object-key", "raw-error", "secret-service"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("metrics body leaked %q:\n%s", forbidden, body)
		}
	}
}

func TestWorkerLeaseAgeRequiresAvailableAcquiredAt(t *testing.T) {
	m := newTestMetrics(t)
	operation := WorkerOperationEmail
	m.SetWorkerBacklog(operation, WorkerBacklogSnapshot{Pending: 1})
	if body := scrapeMetrics(t, m); strings.Contains(body, "duallane_worker_lease_age_seconds") {
		t.Fatalf("unknown lease age was exposed:\n%s", body)
	}

	m.SetWorkerBacklog(operation, WorkerBacklogSnapshot{
		OldestLeaseAge:    5 * time.Second,
		LeaseAgeAvailable: true,
	})
	body := scrapeMetrics(t, m)
	if !strings.Contains(body, `duallane_worker_lease_age_seconds{operation="email"} 5`) {
		t.Fatalf("available lease age missing:\n%s", body)
	}

	// A later query without acquired-at must not turn the last known value
	// into a misleading zero or remove the established series.
	m.SetWorkerBacklog(operation, WorkerBacklogSnapshot{OldestLeaseAge: 0})
	body = scrapeMetrics(t, m)
	if !strings.Contains(body, `duallane_worker_lease_age_seconds{operation="email"} 5`) {
		t.Fatalf("unknown lease age overwrote the last known value:\n%s", body)
	}
}

type testPGPoolStats struct{}

func (testPGPoolStats) MaxConns() int32          { return 8 }
func (testPGPoolStats) TotalConns() int32        { return 5 }
func (testPGPoolStats) AcquiredConns() int32     { return 2 }
func (testPGPoolStats) IdleConns() int32         { return 3 }
func (testPGPoolStats) ConstructingConns() int32 { return 1 }

func TestSnapshotFromPGPoolIsReadOnlyAndTypedNilSafe(t *testing.T) {
	snapshot := SnapshotFromPGPool(testPGPoolStats{})
	want := PGPoolSnapshot{MaxConns: 8, TotalConns: 5, AcquiredConns: 2, IdleConns: 3, ConstructingConns: 1}
	if snapshot != want {
		t.Fatalf("snapshot = %+v, want %+v", snapshot, want)
	}
	var nilStats *testPGPoolStats
	if got := SnapshotFromPGPool(nilStats); got != (PGPoolSnapshot{}) {
		t.Fatalf("typed nil snapshot = %+v", got)
	}
}

type testCumulativePGPoolStats struct {
	testPGPoolStats
	acquireCount         int64
	acquireDuration      time.Duration
	canceledAcquireCount int64
	emptyAcquireCount    int64
}

func (stats testCumulativePGPoolStats) AcquireCount() int64 {
	return stats.acquireCount
}

func (stats testCumulativePGPoolStats) AcquireDuration() time.Duration {
	return stats.acquireDuration
}

func (stats testCumulativePGPoolStats) CanceledAcquireCount() int64 {
	return stats.canceledAcquireCount
}

func (stats testCumulativePGPoolStats) EmptyAcquireCount() int64 {
	return stats.emptyAcquireCount
}

func TestPGPoolCumulativeSnapshotUsesDeltasAndMissingStatsStayMissing(t *testing.T) {
	m := newTestMetrics(t)
	initial := SnapshotFromPGPool(testCumulativePGPoolStats{
		acquireCount: 7, acquireDuration: 1500 * time.Millisecond,
		canceledAcquireCount: 2, emptyAcquireCount: 1,
	})
	if !initial.Cumulative.Available {
		t.Fatal("cumulative pool stats were not detected")
	}
	m.SetPGPool(ServiceWorkspace, initial)
	m.SetPGPool(ServiceWorkspace, initial)
	m.SetPGPool(ServiceWorkspace, PGPoolSnapshot{
		Cumulative: PGPoolCumulativeSnapshot{
			Available: true, AcquireCount: 9, AcquireDuration: 2 * time.Second,
			CanceledAcquireCount: 3, EmptyAcquireCount: 1,
		},
	})

	body := scrapeMetrics(t, m)
	for _, want := range []string{
		`duallane_workspace_postgres_pool_acquires_total{outcome="success",service="workspace"} 9`,
		`duallane_workspace_postgres_pool_acquires_total{outcome="canceled",service="workspace"} 3`,
		`duallane_workspace_postgres_pool_acquires_total{outcome="empty",service="workspace"} 1`,
		`duallane_workspace_postgres_pool_acquire_duration_seconds_total{service="workspace"} 2`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("metrics body missing %q:\n%s", want, body)
		}
	}

	missing := newTestMetrics(t)
	missingSnapshot := SnapshotFromPGPool(testPGPoolStats{})
	if missingSnapshot.Cumulative.Available {
		t.Fatal("gauge-only pool stats fabricated cumulative availability")
	}
	missing.SetPGPool(ServiceWorkspace, missingSnapshot)
	missingBody := scrapeMetrics(t, missing)
	for _, forbidden := range []string{
		"duallane_workspace_postgres_pool_acquires_total",
		"duallane_workspace_postgres_pool_acquire_duration_seconds_total",
	} {
		if strings.Contains(missingBody, forbidden) {
			t.Fatalf("missing cumulative stats emitted %q:\n%s", forbidden, missingBody)
		}
	}
}

func TestPGPoolCumulativeSnapshotsIgnoreLateLowerValues(t *testing.T) {
	m := newTestMetrics(t)
	snapshot := func(acquireCount int64, acquireDuration time.Duration, canceled, empty int64) PGPoolSnapshot {
		return PGPoolSnapshot{Cumulative: PGPoolCumulativeSnapshot{
			Available:            true,
			AcquireCount:         acquireCount,
			AcquireDuration:      acquireDuration,
			CanceledAcquireCount: canceled,
			EmptyAcquireCount:    empty,
		}}
	}

	// A stale sample can be applied after a newer sample because pool.Stat was
	// read before SetPGPool acquired its serialization lock. It must not look
	// like a pool reset.
	m.SetPGPool(ServiceWorkspace, snapshot(100, 10*time.Second, 20, 5))
	m.SetPGPool(ServiceWorkspace, snapshot(90, 9*time.Second, 19, 4))
	m.SetPGPool(ServiceWorkspace, snapshot(110, 11*time.Second, 22, 6))

	var group sync.WaitGroup
	for index := 0; index < 48; index++ {
		group.Add(1)
		go func(index int) {
			defer group.Done()
			value := int64(90 + index%3*10)
			m.SetPGPool(ServiceWorkspace, snapshot(value, time.Duration(value/10)*time.Second, value/5, value/20))
		}(index)
	}
	group.Wait()

	body := scrapeMetrics(t, m)
	for _, want := range []string{
		`duallane_workspace_postgres_pool_acquires_total{outcome="success",service="workspace"} 110`,
		`duallane_workspace_postgres_pool_acquires_total{outcome="canceled",service="workspace"} 22`,
		`duallane_workspace_postgres_pool_acquires_total{outcome="empty",service="workspace"} 6`,
		`duallane_workspace_postgres_pool_acquire_duration_seconds_total{service="workspace"} 11`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("metrics body missing %q:\n%s", want, body)
		}
	}
}

func TestPGPoolCumulativeSetIsStableUnderConcurrentSnapshotsAndGathers(t *testing.T) {
	m := newTestMetrics(t)
	snapshot := SnapshotFromPGPool(testCumulativePGPoolStats{
		acquireCount: 11, acquireDuration: 3 * time.Second,
		canceledAcquireCount: 4, emptyAcquireCount: 2,
	})

	var group sync.WaitGroup
	for index := 0; index < 32; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			m.SetPGPool(ServiceWorker, snapshot)
		}()
	}
	for index := 0; index < 32; index++ {
		if _, err := m.registry.Gather(); err != nil {
			t.Fatalf("Gather() error = %v", err)
		}
	}
	group.Wait()
	body := scrapeMetrics(t, m)
	for _, want := range []string{
		`duallane_workspace_postgres_pool_acquires_total{outcome="success",service="worker"} 11`,
		`duallane_workspace_postgres_pool_acquires_total{outcome="canceled",service="worker"} 4`,
		`duallane_workspace_postgres_pool_acquires_total{outcome="empty",service="worker"} 2`,
		`duallane_workspace_postgres_pool_acquire_duration_seconds_total{service="worker"} 3`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("metrics body missing %q:\n%s", want, body)
		}
	}
}

func TestHandlerGatherIsPassiveAndConcurrent(t *testing.T) {
	m := newTestMetrics(t)
	first := scrapeMetrics(t, m)
	second := scrapeMetrics(t, m)
	for _, stable := range []string{
		"duallane_workspace_websocket_connections 0",
	} {
		if !strings.Contains(first, stable) || !strings.Contains(second, stable) {
			t.Fatalf("read-only metrics handler changed %q", stable)
		}
	}
	methodRecorder := httptest.NewRecorder()
	m.Handler().ServeHTTP(methodRecorder, httptest.NewRequest(http.MethodPost, "/metrics", nil))
	if methodRecorder.Code != http.StatusMethodNotAllowed || methodRecorder.Header().Get("Allow") != "GET, HEAD" {
		t.Fatalf("metrics POST status=%d allow=%q", methodRecorder.Code, methodRecorder.Header().Get("Allow"))
	}
	if after := scrapeMetrics(t, m); !strings.Contains(after, "duallane_workspace_websocket_connections 0") {
		t.Fatal("rejected metrics method changed observations")
	}

	var group sync.WaitGroup
	for index := 0; index < 4; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			for count := 0; count < 100; count++ {
				m.ObserveHTTP(ServiceWorkspace, http.MethodGet, testRoute, http.StatusOK, time.Millisecond)
				m.AddWorkspaceWebSocketConnections(1)
				m.AddWorkspaceWebSocketConnections(-1)
				m.SetWorkerBacklog(WorkerOperationEmail, WorkerBacklogSnapshot{Pending: 1})
				m.ObserveObject(ServiceWorker, ObjectOperationOpen, ObjectOutcomeSuccess, 1)
			}
		}()
	}
	for count := 0; count < 100; count++ {
		if _, err := m.registry.Gather(); err != nil {
			t.Fatalf("Gather() error = %v", err)
		}
	}
	group.Wait()
}
