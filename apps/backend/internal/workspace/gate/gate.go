// Package gate owns the Workspace feature boundary and its public health
// projection. It deliberately contains no database or domain dependencies so
// disabled hosts can answer without opening Workspace resources.
package gate

import (
	"encoding/json"
	"net/http"
)

const (
	// EnvironmentName is the only switch that enables Workspace.
	EnvironmentName = "WORKSPACE_ENABLED"

	DisabledCode    = "workspace.disabled"
	DisabledMessage = "共享空间暂未开放"
)

// State is the public service readiness state. Disabled is distinct from a
// dependency failure so operators and clients can tell an intentional gate
// from a broken enabled service.
type State string

const (
	StateDisabled State = "disabled"
	StateNotReady State = "not_ready"
	StateReady    State = "ready"
	StateDegraded State = "degraded"
)

// Gate evaluates the exact Workspace feature flag. The value is intentionally
// not parsed as a general boolean: only the literal "true" opens the lane.
type Gate struct {
	enabled bool
}

func New(enabledValue string) Gate {
	return Gate{enabled: enabledValue == "true"}
}

func NewFromLookup(lookup func(string) string) Gate {
	if lookup == nil {
		return Gate{}
	}
	return New(lookup(EnvironmentName))
}

func (g Gate) Enabled() bool {
	return g.enabled
}

func (g Gate) State() State {
	if !g.enabled {
		return StateDisabled
	}
	return StateReady
}

// Error is the stable public error returned before any Workspace dependency is
// accessed.
type Error struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	StatusCode int    `json:"-"`
}

func (e *Error) Error() string {
	return e.Code
}

func DisabledError() *Error {
	return &Error{Code: DisabledCode, Message: DisabledMessage, StatusCode: http.StatusServiceUnavailable}
}

// Middleware applies the gate before the wrapped handler. It is safe to put
// this in front of handlers that would otherwise need a database or auth
// service: disabled requests never reach them.
func (g Gate) Middleware(next http.Handler) http.Handler {
	if next == nil {
		next = http.NotFoundHandler()
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !g.enabled {
			WriteDisabled(w)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type errorEnvelope struct {
	Error Error `json:"error"`
}

func WriteDisabled(w http.ResponseWriter) {
	WriteJSON(w, http.StatusServiceUnavailable, errorEnvelope{Error: *DisabledError()})
}

func WriteJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	// The response is already fully shaped by the caller. There is no useful
	// recovery path after headers are written, so intentionally ignore encoder
	// errors here.
	_ = json.NewEncoder(w).Encode(value)
}

// HealthInput contains only safe operational facts. Dependency names and
// booleans may be projected; connection strings, hosts, provider responses,
// and internal errors must stay out of this type.
type HealthInput struct {
	Service          string
	Version          string
	Commit           string
	Live             bool
	DatabaseReady    bool
	ObjectStoreReady bool
	Workspace        Gate
}

type HealthProjection struct {
	OK         bool   `json:"ok"`
	Service    string `json:"service"`
	Lane       string `json:"lane"`
	State      State  `json:"state"`
	AppVersion string `json:"appVersion,omitempty"`
	Version    string `json:"version,omitempty"`
	Commit     string `json:"commit,omitempty"`
}

// PublicHealthProjection preserves the existing public /api/health contract.
// Readiness details belong to the private /readyz projection below.
type PublicHealthProjection struct {
	OK         bool   `json:"ok"`
	Service    string `json:"service"`
	Lane       string `json:"lane"`
	AppVersion string `json:"appVersion"`
}

// ProjectHealth maps service facts to a safe health document. Liveness is
// represented by OK, while readiness is represented by Lane/state. An
// intentionally disabled Workspace is healthy but not ready for Workspace
// traffic, matching the current API's always-live /api/health behavior.
func ProjectHealth(input HealthInput) HealthProjection {
	service := input.Service
	if service == "" {
		service = "workspace"
	}

	state := StateReady
	if !input.Workspace.Enabled() {
		state = StateDisabled
	} else if !input.Live || !input.DatabaseReady || !input.ObjectStoreReady {
		state = StateNotReady
	}

	lane := "ready"
	if state != StateReady {
		lane = string(state)
	}
	return HealthProjection{
		OK:         input.Live,
		Service:    service,
		Lane:       lane,
		State:      state,
		AppVersion: input.Version,
		Version:    input.Version,
		Commit:     input.Commit,
	}
}

func ProjectPublicHealth(input HealthInput) PublicHealthProjection {
	return PublicHealthProjection{
		OK:         input.Live,
		Service:    "duallane",
		Lane:       "ready",
		AppVersion: input.Version,
	}
}

func HealthHandler(input func() HealthInput) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if input == nil {
			WriteJSON(w, http.StatusInternalServerError, map[string]any{
				"error": map[string]string{
					"code":    "internal.error",
					"message": "服务暂时不可用",
				},
			})
			return
		}
		projection := ProjectPublicHealth(input())
		status := http.StatusOK
		if !projection.OK {
			status = http.StatusServiceUnavailable
		}
		WriteJSON(w, status, projection)
	})
}

// ReadinessHandler is intended for private orchestration checks. It exposes
// dependency state separately so the public health response remains backward
// compatible.
func ReadinessHandler(input func() HealthInput) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if input == nil {
			WriteJSON(w, http.StatusInternalServerError, map[string]any{
				"error": map[string]string{
					"code":    "internal.error",
					"message": "服务暂时不可用",
				},
			})
			return
		}
		projection := ProjectHealth(input())
		status := http.StatusOK
		if !projection.OK || projection.State == StateNotReady {
			status = http.StatusServiceUnavailable
		}
		WriteJSON(w, status, projection)
	})
}

// StatusProjection is the small public projection used by the Workspace
// entry boundary. It intentionally contains no membership, identity, or
// database details.
type StatusProjection struct {
	Enabled bool   `json:"enabled"`
	State   State  `json:"state"`
	Service string `json:"service"`
}

func ProjectStatus(g Gate, service string) StatusProjection {
	if service == "" {
		service = "workspace"
	}
	return StatusProjection{Enabled: g.Enabled(), State: g.State(), Service: service}
}

func StatusHandler(g Gate, service string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		status := ProjectStatus(g, service)
		WriteJSON(w, http.StatusOK, status)
	})
}
