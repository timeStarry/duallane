package httpserver

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"
)

const DefaultShutdownTimeout = 10 * time.Second

// New creates a conservative HTTP server suitable for a private service. The
// caller owns the listener and graceful shutdown lifecycle.
func New(address string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              address,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}
}

// Serve runs the server and shuts it down when ctx is cancelled. A normal
// http.ErrServerClosed result is converted to nil.
func Serve(ctx context.Context, server *http.Server, logger *slog.Logger, shutdownTimeout time.Duration) error {
	if server == nil {
		return errors.New("http server is required")
	}
	if shutdownTimeout <= 0 {
		shutdownTimeout = DefaultShutdownTimeout
	}
	serveErr := make(chan error, 1)
	go func() {
		serveErr <- server.ListenAndServe()
	}()

	select {
	case err := <-serveErr:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			if logger != nil {
				logger.Warn("http shutdown incomplete", slog.String("error_code", "shutdown_timeout"))
			}
			return err
		}
		select {
		case err := <-serveErr:
			if errors.Is(err, http.ErrServerClosed) {
				return nil
			}
			return err
		case <-shutdownCtx.Done():
			return shutdownCtx.Err()
		}
	}
}

// SecurityHeaders adds response headers that do not depend on a public
// hostname and are safe for JSON/health responses. The edge proxy remains
// responsible for the complete browser policy.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}
