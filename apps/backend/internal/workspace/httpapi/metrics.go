package httpapi

import (
	"net/http"
	"sort"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type HTTPObserver func(method, routeTemplate string, status int, duration time.Duration)

func observeHTTP(observer HTTPObserver) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			started := time.Now()
			wrapped := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			defer func() {
				status := wrapped.Status()
				if status == 0 {
					status = http.StatusOK
				}
				// The chi template is populated after routing. Never fall back
				// to URL.Path, query strings or actor/resource identifiers.
				observer(r.Method, chi.RouteContext(r.Context()).RoutePattern(), status, time.Since(started))
			}()
			next.ServeHTTP(wrapped, r)
		})
	}
}

// RouteTemplates derives a static label allowlist from the same route table.
// Constructing a router registers handlers only and never opens dependencies.
func RouteTemplates() ([]string, error) {
	router := NewRouter(RouterOptions{AuthRoutes: &auth.HTTPHandler{}, Health: http.NotFoundHandler(), Readiness: http.NotFoundHandler()})
	paths := map[string]bool{}
	err := chi.Walk(router.(chi.Routes), func(_, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		paths[route] = true
		return nil
	})
	if err != nil {
		return nil, err
	}
	result := make([]string, 0, len(paths))
	for route := range paths {
		result = append(result, route)
	}
	sort.Strings(result)
	return result, nil
}
