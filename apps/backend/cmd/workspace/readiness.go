package main

import (
	"context"
	"net/http"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
)

func candidateHealthRouter(health, ready http.Handler) http.Handler {
	router := http.NewServeMux()
	router.Handle("GET /api/health", health)
	router.Handle("GET /readyz", ready)
	router.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		gate.WriteJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": map[string]string{"code": "workspace.candidate_passive", "message": "服务暂时不可用"},
		})
	})
	return router
}

func readinessHandler(input func() gate.HealthInput, database, storage func(context.Context) error) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		facts := input()
		if facts.Live && facts.Workspace.Enabled() {
			ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
			defer cancel()
			facts.DatabaseReady = database != nil && database(ctx) == nil
			facts.ObjectStoreReady = storage != nil && storage(ctx) == nil
		}
		// Raw dependency errors are intentionally not retained or projected.
		gate.ReadinessHandler(func() gate.HealthInput { return facts }).ServeHTTP(w, r)
	})
}
