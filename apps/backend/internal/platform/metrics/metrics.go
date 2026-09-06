// Package metrics provides the private, process-local Prometheus surface for
// Workspace HTTP, WebSocket, PostgreSQL, worker, and object observations.
//
// The package deliberately accepts already-sanitized snapshots and fixed
// categories. It never receives a user, conversation, token, URL, object key,
// or raw error, and Handler only gathers private collectors and read-only
// process/runtime state.
package metrics

import (
	"net/http"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

const (
	metricNamespace          = "duallane"
	workspaceMetricSubsystem = "workspace"
	workerMetricSubsystem    = "worker"
)

const maxInt64Value = int64(^uint64(0) >> 1)

// Options controls construction of a private metrics registry.
type Options struct {
	// RouteTemplates is the exact allowlist of router templates that may be
	// emitted as HTTP labels. Runtime paths and unlisted templates are always
	// reported as "unknown".
	RouteTemplates []string
}

// Recorder is the narrow observation surface that Workspace and worker
// composition can inject without importing a database, storage, or domain
// repository into this package.
type Recorder interface {
	ObserveHTTP(Service, string, string, int, time.Duration)
	SetWorkspaceWebSocketConnections(int64)
	AddWorkspaceWebSocketConnections(int64)
	ObserveWorkspaceWebSocketReplay(int64, bool)
	ObserveWorkspaceWebSocketReplayLag(time.Duration)
	ObserveWorkspaceWebSocketReplayDuration(time.Duration)
	SetPGPool(Service, PGPoolSnapshot)
	ObservePGPoolAcquire(Service, PGPoolAcquireOutcome, time.Duration)
	SetWorkerBacklog(WorkerOperation, WorkerBacklogSnapshot)
	ObserveWorkerResult(WorkerOperation, WorkerResult)
	ObserveWorkerOutcome(WorkerOperation, WorkerResultKind, int64)
	ObserveObject(Service, ObjectOperation, ObjectOutcome, int64)
}

var _ Recorder = (*Metrics)(nil)

// Metrics owns a private registry and its process-local collectors.
type Metrics struct {
	registry *prometheus.Registry
	routes   map[string]struct{}

	httpRequests        *prometheus.CounterVec
	httpRequestDuration *prometheus.HistogramVec

	workspaceWebSocketConnections    prometheus.Gauge
	workspaceWebSocketReplays        prometheus.Counter
	workspaceWebSocketReplayEvents   prometheus.Counter
	workspaceWebSocketReplayLag      prometheus.Histogram
	workspaceWebSocketReplayDuration prometheus.Histogram
	workspaceWebSocketSyncRequired   prometheus.Counter

	postgresPoolMax             *prometheus.GaugeVec
	postgresPoolTotal           *prometheus.GaugeVec
	postgresPoolAcquired        *prometheus.GaugeVec
	postgresPoolIdle            *prometheus.GaugeVec
	postgresPoolConstructing    *prometheus.GaugeVec
	postgresPoolAcquires        *prometheus.CounterVec
	postgresPoolWait            *prometheus.HistogramVec
	postgresPoolAcquireDuration *prometheus.CounterVec

	pgpoolMu         sync.Mutex
	pgpoolCumulative map[string]pgpoolCumulativeBaseline

	workerBacklog    *prometheus.GaugeVec
	workerBacklogAge *prometheus.GaugeVec
	workerLeaseAge   *prometheus.GaugeVec
	workerResults    *prometheus.CounterVec

	objectOperations *prometheus.CounterVec
	objectBytes      *prometheus.CounterVec

	webSocketMu              sync.Mutex
	webSocketConnectionValue int64
}

// New constructs a private registry. It does not register collectors in the
// process-wide Prometheus default registry.
func New(options Options) (*Metrics, error) {
	routes, err := newRouteSet(options.RouteTemplates)
	if err != nil {
		return nil, err
	}

	m := &Metrics{
		registry: prometheus.NewRegistry(),
		routes:   routes,

		httpRequests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: metricNamespace, Subsystem: workspaceMetricSubsystem,
			Name: "http_requests_total", Help: "Workspace and worker HTTP requests by safe service, method, route template, and status class.",
		}, []string{"service", "method", "route", "status_class"}),
		httpRequestDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Namespace: metricNamespace, Subsystem: workspaceMetricSubsystem,
			Name: "http_request_duration_seconds", Help: "Workspace and worker HTTP request duration in seconds.",
		}, []string{"service", "method", "route"}),

		workspaceWebSocketConnections: prometheus.NewGauge(prometheus.GaugeOpts{
			Namespace: metricNamespace, Subsystem: workspaceMetricSubsystem,
			Name: "websocket_connections", Help: "Current Workspace WebSocket connection count.",
		}),
		workspaceWebSocketReplays: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: metricNamespace, Subsystem: workspaceMetricSubsystem,
			Name: "websocket_replays_total", Help: "Workspace WebSocket replay attempts.",
		}),
		workspaceWebSocketReplayEvents: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: metricNamespace, Subsystem: workspaceMetricSubsystem,
			Name: "websocket_replay_events_total", Help: "Workspace events included in WebSocket replays.",
		}),
		workspaceWebSocketReplayLag: prometheus.NewHistogram(prometheus.HistogramOpts{
			Namespace: metricNamespace, Subsystem: workspaceMetricSubsystem,
			Name: "websocket_replay_lag_seconds", Help: "Age of the oldest durable event included in a Workspace WebSocket replay batch.",
		}),
		workspaceWebSocketReplayDuration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Namespace: metricNamespace, Subsystem: workspaceMetricSubsystem,
			Name: "websocket_replay_duration_seconds", Help: "Time spent reading one Workspace WebSocket replay batch.",
		}),
		workspaceWebSocketSyncRequired: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: metricNamespace, Subsystem: workspaceMetricSubsystem,
			Name: "websocket_sync_required_total", Help: "Workspace WebSocket sessions requiring a replay or sync.",
		}),

		postgresPoolMax: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Namespace: metricNamespace, Subsystem: workspaceMetricSubsystem,
			Name: "postgres_pool_max_connections", Help: "Configured PostgreSQL pool maximum connections.",
		}, []string{"service"}),
		postgresPoolTotal: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Namespace: metricNamespace, Subsystem: workspaceMetricSubsystem,
			Name: "postgres_pool_total_connections", Help: "Current PostgreSQL pool connections.",
		}, []string{"service"}),
		postgresPoolAcquired: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Namespace: metricNamespace, Subsystem: workspaceMetricSubsystem,
			Name: "postgres_pool_acquired_connections", Help: "Current acquired PostgreSQL pool connections.",
		}, []string{"service"}),
		postgresPoolIdle: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Namespace: metricNamespace, Subsystem: workspaceMetricSubsystem,
			Name: "postgres_pool_idle_connections", Help: "Current idle PostgreSQL pool connections.",
		}, []string{"service"}),
		postgresPoolConstructing: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Namespace: metricNamespace, Subsystem: workspaceMetricSubsystem,
			Name: "postgres_pool_constructing_connections", Help: "Current PostgreSQL connections under construction.",
		}, []string{"service"}),
		postgresPoolAcquires: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: metricNamespace, Subsystem: workspaceMetricSubsystem,
			Name: "postgres_pool_acquires_total", Help: "PostgreSQL pool acquire outcomes by safe category.",
		}, []string{"service", "outcome"}),
		postgresPoolWait: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Namespace: metricNamespace, Subsystem: workspaceMetricSubsystem,
			Name: "postgres_pool_wait_seconds", Help: "Time spent waiting for a PostgreSQL pool acquire.",
		}, []string{"service"}),
		postgresPoolAcquireDuration: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: metricNamespace, Subsystem: workspaceMetricSubsystem,
			Name: "postgres_pool_acquire_duration_seconds_total", Help: "Cumulative PostgreSQL pool acquire duration in seconds from pool statistics.",
		}, []string{"service"}),

		pgpoolCumulative: make(map[string]pgpoolCumulativeBaseline),

		workerBacklog: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Namespace: metricNamespace, Subsystem: workerMetricSubsystem,
			Name: "backlog", Help: "Current bounded worker backlog by fixed operation.",
		}, []string{"operation"}),
		workerBacklogAge: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Namespace: metricNamespace, Subsystem: workerMetricSubsystem,
			Name: "backlog_age_seconds", Help: "Age of the oldest eligible worker item by fixed operation.",
		}, []string{"operation"}),
		workerLeaseAge: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Namespace: metricNamespace, Subsystem: workerMetricSubsystem,
			Name: "lease_age_seconds", Help: "Age of the oldest active worker lease by fixed operation.",
		}, []string{"operation"}),
		workerResults: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: metricNamespace, Subsystem: workerMetricSubsystem,
			Name: "results_total", Help: "Worker eligible, lease, completion, retry, and failure results by fixed operation.",
		}, []string{"operation", "result"}),

		objectOperations: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: metricNamespace, Subsystem: workspaceMetricSubsystem,
			Name: "object_operations_total", Help: "Workspace object operations by fixed operation and safe outcome.",
		}, []string{"service", "operation", "outcome"}),
		objectBytes: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: metricNamespace, Subsystem: workspaceMetricSubsystem,
			Name: "object_bytes_total", Help: "Workspace object bytes processed by fixed operation and safe outcome.",
		}, []string{"service", "operation", "outcome"}),
	}

	m.registry.MustRegister(
		m.httpRequests, m.httpRequestDuration,
		m.workspaceWebSocketConnections, m.workspaceWebSocketReplays,
		m.workspaceWebSocketReplayEvents, m.workspaceWebSocketReplayLag,
		m.workspaceWebSocketReplayDuration,
		m.workspaceWebSocketSyncRequired,
		m.postgresPoolMax, m.postgresPoolTotal, m.postgresPoolAcquired,
		m.postgresPoolIdle, m.postgresPoolConstructing, m.postgresPoolAcquires,
		m.postgresPoolWait, m.postgresPoolAcquireDuration,
		m.workerBacklog, m.workerBacklogAge, m.workerLeaseAge, m.workerResults,
		m.objectOperations, m.objectBytes,
		collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)
	return m, nil
}

// Handler returns a read-only Prometheus handler backed by this private
// registry. A nil receiver is intentionally unavailable.
func (m *Metrics) Handler() http.Handler {
	if m == nil || m.registry == nil {
		return http.NotFoundHandler()
	}
	metricsHandler := promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{})
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet && request.Method != http.MethodHead {
			response.Header().Set("Allow", "GET, HEAD")
			http.Error(response, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
			return
		}
		metricsHandler.ServeHTTP(response, request)
	})
}

// ObserveHTTP records one request using only the configured route template.
// A runtime path, unknown method, or unknown status is reduced to a fixed
// category before it reaches a collector.
func (m *Metrics) ObserveHTTP(service Service, method, routeTemplate string, statusCode int, duration time.Duration) {
	if m == nil {
		return
	}
	if _, ok := m.routes[routeTemplate]; !ok {
		routeTemplate = "unknown"
	}
	if duration < 0 {
		duration = 0
	}
	serviceLabel := normalizeService(service)
	methodLabel := normalizeMethod(method)
	m.httpRequests.WithLabelValues(serviceLabel, methodLabel, routeTemplate, normalizeStatusClass(statusCode)).Inc()
	m.httpRequestDuration.WithLabelValues(serviceLabel, methodLabel, routeTemplate).Observe(duration.Seconds())
}

// SetWorkspaceWebSocketConnections sets the non-negative active connection
// gauge. It is process-local and has no user or conversation labels.
func (m *Metrics) SetWorkspaceWebSocketConnections(value int64) {
	if m == nil {
		return
	}
	if value < 0 {
		value = 0
	}
	m.webSocketMu.Lock()
	m.webSocketConnectionValue = value
	m.workspaceWebSocketConnections.Set(float64(value))
	m.webSocketMu.Unlock()
}

// AddWorkspaceWebSocketConnections adjusts the active connection gauge while
// clamping the result to zero.
func (m *Metrics) AddWorkspaceWebSocketConnections(delta int64) {
	if m == nil {
		return
	}
	m.webSocketMu.Lock()
	m.webSocketConnectionValue = addNonNegative(m.webSocketConnectionValue, delta)
	m.workspaceWebSocketConnections.Set(float64(m.webSocketConnectionValue))
	m.webSocketMu.Unlock()
}

func addNonNegative(current, delta int64) int64 {
	if delta > 0 {
		if current > maxInt64Value-delta {
			return maxInt64Value
		}
		return current + delta
	}
	if delta < 0 {
		// Avoid negating MinInt64. Any negative delta that large necessarily
		// takes a non-negative count to zero.
		if delta == -maxInt64Value-1 || current <= -delta {
			return 0
		}
		return current + delta
	}
	return current
}

// ObserveWorkspaceWebSocketReplay records a replay attempt, its event count,
// and whether the transport requires synchronization. Event age is recorded
// separately only when a durable event timestamp is available.
func (m *Metrics) ObserveWorkspaceWebSocketReplay(replayedEvents int64, syncRequired bool) {
	if m == nil {
		return
	}
	if replayedEvents < 0 {
		replayedEvents = 0
	}
	m.workspaceWebSocketReplays.Inc()
	m.workspaceWebSocketReplayEvents.Add(float64(replayedEvents))
	if syncRequired {
		m.workspaceWebSocketSyncRequired.Inc()
	}
}

// ObserveWorkspaceWebSocketReplayLag records the age of the oldest durable
// event in a replay batch. Callers must not call this method for a batch with
// no valid CreatedAt value.
func (m *Metrics) ObserveWorkspaceWebSocketReplayLag(lag time.Duration) {
	if m == nil {
		return
	}
	if lag < 0 {
		lag = 0
	}
	m.workspaceWebSocketReplayLag.Observe(lag.Seconds())
}

// ObserveWorkspaceWebSocketReplayDuration records the bounded Replay call
// duration independently from durable event age.
func (m *Metrics) ObserveWorkspaceWebSocketReplayDuration(duration time.Duration) {
	if m == nil {
		return
	}
	if duration < 0 {
		duration = 0
	}
	m.workspaceWebSocketReplayDuration.Observe(duration.Seconds())
}
