package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
	"github.com/timestarry/duallane/apps/backend/internal/platform/logging"
	"github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/email"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/ntfy"
)

const serviceName = "worker"

type processResult struct {
	Claimed   int
	Sent      int
	Cancelled int
	Retried   int
	Failed    int
}

type workerProcessor struct {
	name     string
	interval time.Duration
	process  func(context.Context) (processResult, error)
}

type application struct {
	pool         *pgxpool.Pool
	processors   []workerProcessor
	logger       *slog.Logger
	startupDelay time.Duration
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
	app := &application{logger: logger, startupDelay: time.Minute}
	if !runtimeConfig.Enabled || (!runtimeConfig.NtfyWorkerEnabled && !runtimeConfig.EmailWorkerEnabled) {
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
	if runtimeConfig.NtfyWorkerEnabled {
		service, err := ntfy.NewServiceWithError(ntfy.ServiceOptions{
			Repository: ntfy.NewPGRepository(pool), ServerURL: runtimeConfig.NtfyBaseURL,
			FrontendURL: frontendURL,
		})
		if err != nil {
			pool.Close()
			return nil, err
		}
		app.processors = append(app.processors, workerProcessor{
			name: "ntfy", interval: ntfy.DefaultWorkerInterval,
			process: func(ctx context.Context) (processResult, error) {
				result, err := service.ProcessJobs(ctx)
				return processResult(result), err
			},
		})
	}
	if runtimeConfig.EmailWorkerEnabled {
		service, err := email.NewServiceWithError(email.ServiceOptions{
			Repository: email.NewPGRepository(pool), FrontendURL: frontendURL,
			EncryptionKeyB64: runtimeConfig.SMTPEncryptionKey,
		})
		if err != nil {
			pool.Close()
			return nil, err
		}
		app.processors = append(app.processors, workerProcessor{
			name: "email", interval: email.DefaultWorkerInterval,
			process: func(ctx context.Context) (processResult, error) {
				result, err := service.ProcessJobs(ctx)
				return processResult(result), err
			},
		})
	}
	app.pool = pool
	return app, nil
}

func (app *application) run(ctx context.Context) {
	if ctx == nil {
		ctx = context.Background()
	}
	if app == nil || len(app.processors) == 0 {
		<-ctx.Done()
		return
	}
	var wait sync.WaitGroup
	for _, configured := range app.processors {
		processor := configured
		wait.Add(1)
		go func() {
			defer wait.Done()
			app.runProcessor(ctx, processor)
		}()
	}
	wait.Wait()
}

func (app *application) runProcessor(ctx context.Context, processor workerProcessor) {
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
	app.tick(ctx, processor)
	interval := processor.interval
	if interval <= 0 {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			app.tick(ctx, processor)
		}
	}
}

func (app *application) tick(ctx context.Context, processor workerProcessor) {
	if processor.process == nil {
		return
	}
	result, err := processor.process(ctx)
	if err != nil {
		if app.logger != nil {
			app.logger.Error("worker cycle failed", slog.String("worker", processor.name), slog.String("error_code", processor.name+"_cycle_failed"))
		}
		return
	}
	if app.logger != nil && result.Claimed > 0 {
		app.logger.Info("worker cycle completed", slog.String("worker", processor.name),
			slog.Int("claimed", result.Claimed), slog.Int("sent", result.Sent),
			slog.Int("cancelled", result.Cancelled), slog.Int("retried", result.Retried),
			slog.Int("failed", result.Failed))
	}
}
