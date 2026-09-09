package metrics

import (
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Metrics contains process-local, privacy-safe P2P metrics. Labels are fixed
// route/status categories only; no room, peer, envelope, or user identifiers
// are ever accepted.
type Metrics struct {
	registry          *prometheus.Registry
	requests          *prometheus.CounterVec
	requestDuration   *prometheus.HistogramVec
	rooms             prometheus.Gauge
	activeConnections prometheus.Gauge
	rejectedFrames    *prometheus.CounterVec
	relayedEnvelopes  prometheus.Counter
}

func New() *Metrics {
	registry := prometheus.NewRegistry()
	m := &Metrics{
		registry: registry,
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: "duallane",
			Subsystem: "p2p",
			Name:      "http_requests_total",
			Help:      "Total P2P HTTP requests by method, route, and status class.",
		}, []string{"method", "route", "status_class"}),
		requestDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Namespace: "duallane",
			Subsystem: "p2p",
			Name:      "http_request_duration_seconds",
			Help:      "P2P HTTP request duration in seconds.",
		}, []string{"method", "route"}),
		rooms: prometheus.NewGauge(prometheus.GaugeOpts{
			Namespace: "duallane",
			Subsystem: "p2p",
			Name:      "rooms",
			Help:      "Current in-memory P2P room count.",
		}),
		activeConnections: prometheus.NewGauge(prometheus.GaugeOpts{
			Namespace: "duallane",
			Subsystem: "p2p",
			Name:      "active_connections",
			Help:      "Current P2P WebSocket connection count.",
		}),
		rejectedFrames: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: "duallane",
			Subsystem: "p2p",
			Name:      "rejected_frames_total",
			Help:      "Rejected P2P WebSocket frames by safe reason category.",
		}, []string{"reason"}),
		relayedEnvelopes: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: "duallane",
			Subsystem: "p2p",
			Name:      "relayed_envelopes_total",
			Help:      "Secure envelopes relayed without inspecting their content.",
		}),
	}
	registry.MustRegister(
		m.requests,
		m.requestDuration,
		m.rooms,
		m.activeConnections,
		m.rejectedFrames,
		m.relayedEnvelopes,
	)
	return m
}

func (m *Metrics) Handler() http.Handler {
	if m == nil {
		return http.NotFoundHandler()
	}
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{})
}

func (m *Metrics) ObserveRequest(method, route string, status int, duration time.Duration) {
	if m == nil {
		return
	}
	method = safeMethod(method)
	statusClass := status / 100
	if statusClass < 1 || statusClass > 5 {
		statusClass = 5
	}
	m.requests.WithLabelValues(method, route, string(rune('0'+statusClass))+"xx").Inc()
	m.requestDuration.WithLabelValues(method, route).Observe(duration.Seconds())
}

func safeMethod(value string) string {
	switch value {
	case "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS":
		return value
	default:
		return "OTHER"
	}
}

func (m *Metrics) SetRooms(value int) {
	if m != nil {
		m.rooms.Set(float64(value))
	}
}

func (m *Metrics) AddConnection(delta int) {
	if m != nil {
		m.activeConnections.Add(float64(delta))
	}
}

func (m *Metrics) RejectFrame(reason string) {
	if m == nil {
		return
	}
	if !safeReason(reason) {
		reason = "other"
	}
	m.rejectedFrames.WithLabelValues(reason).Inc()
}

func (m *Metrics) RelayEnvelope() {
	if m != nil {
		m.relayedEnvelopes.Inc()
	}
}

func safeReason(value string) bool {
	switch value {
	case "invalid_json", "invalid_type", "invalid_envelope", "message_too_large", "binary_frame", "room_full", "room_not_found", "other":
		return true
	default:
		return false
	}
}
