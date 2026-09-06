package main

import (
	"context"
	"net/http"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
)

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
