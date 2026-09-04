package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
	"github.com/timestarry/duallane/apps/backend/internal/platform/logging"
	"github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/ntfy"
)

const serviceName = "worker"

type processor func(context.Context) (ntfy.ProcessResult, error)

type application struct {
	pool          *pgxpool.Pool
	ntfyProcessor processor
	logger        *slog.Logger
	interval      time.Duration
	startupDelay  time.Duration
}

func main() {
	logger := logging.New(logging.Options{Service: serviceName, Writer: os.Stderr})
	runtimeConfig, err := config.LoadWorkspace()
	if err != nil {
		logger.Error("invalid worker configuration", slog.String("error_code", "config_invalid"))
		os.Exit(2)
	}
	logger = logging.New(logging.Options{
		Service: serviceName, Version: runtimeConfig.AppVersion, Commit: runtimeConfig.Commit, Writer: os.Stderr,
	})
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	app, err := newApplication(ctx, runtimeConfig, logger)
	if err != nil {
		logger.Error("worker dependencies unavailable", slog.String("error_code", "dependency_unavailable"))
		os.Exit(1)
	}
	if app.pool != nil {
		defer app.pool.Close()
	}
	app.run(ctx)
}

func newApplication(ctx context.Context, runtimeConfig config.WorkspaceConfig, logger *slog.Logger) (*application, error) {
	app := &application{logger: logger, interval: ntfy.DefaultWorkerInterval, startupDelay: time.Minute}
	if !runtimeConfig.Enabled || !runtimeConfig.NtfyWorkerEnabled {
		return app, nil
	}
	pool, err := postgres.OpenPoolFromEnv(ctx)
	if err != nil {
		return nil, err
	}
	frontendURL := runtimeConfig.FrontendURL
	if frontendURL == "" {
		frontendURL = runtimeConfig.PublicBaseURL
	}
	service, err := ntfy.NewServiceWithError(ntfy.ServiceOptions{
		Repository: ntfy.NewPGRepository(pool), ServerURL: runtimeConfig.NtfyBaseURL,
		FrontendURL: frontendURL,
	})
	if err != nil {
		pool.Close()
		return nil, err
	}
	app.pool = pool
	app.ntfyProcessor = service.ProcessJobs
	return app, nil
}

func (app *application) run(ctx context.Context) {
	if ctx == nil {
		ctx = context.Background()
	}
	if app == nil || app.ntfyProcessor == nil {
		<-ctx.Done()
		return
	}
	delay := app.startupDelay
	if delay < 0 {
		delay = 0
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return
	case <-timer.C:
	}
	app.tick(ctx)
	interval := app.interval
	if interval <= 0 {
		interval = ntfy.DefaultWorkerInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			app.tick(ctx)
		}
	}
}

func (app *application) tick(ctx context.Context) {
	result, err := app.ntfyProcessor(ctx)
	if err != nil {
		if app.logger != nil {
			app.logger.Error("ntfy worker cycle failed", slog.String("error_code", "ntfy_cycle_failed"))
		}
		return
	}
	if app.logger != nil && result.Claimed > 0 {
		app.logger.Info("ntfy worker cycle completed",
			slog.Int("claimed", result.Claimed), slog.Int("sent", result.Sent),
			slog.Int("cancelled", result.Cancelled), slog.Int("retried", result.Retried),
			slog.Int("failed", result.Failed))
	}
}
