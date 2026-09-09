package main

import (
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/platform/metrics"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/httpapi"
)

func newWorkspaceMetrics() (*metrics.Metrics, error) {
	routes, err := httpapi.RouteTemplates()
	if err != nil {
		return nil, err
	}
	return metrics.New(metrics.Options{RouteTemplates: routes})
}

func workspaceHTTPObserver(recorder *metrics.Metrics) httpapi.HTTPObserver {
	return func(method, route string, status int, duration time.Duration) {
		recorder.ObserveHTTP(metrics.ServiceWorkspace, method, route, status, duration)
	}
}

func withPrivateWorkspaceMetrics(next http.Handler, recorder *metrics.Metrics, pool *pgxpool.Pool) http.Handler {
	private := recorder.Handler()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/metrics" {
			next.ServeHTTP(w, r)
			return
		}
		if pool != nil {
			recorder.SetPGPool(metrics.ServiceWorkspace, metrics.SnapshotFromPGPool(pool.Stat()))
		}
		private.ServeHTTP(w, r)
	})
}
