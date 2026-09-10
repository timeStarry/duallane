package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
	"github.com/timestarry/duallane/apps/backend/internal/platform/httpserver"
	"github.com/timestarry/duallane/apps/backend/internal/platform/logging"
	platformmetrics "github.com/timestarry/duallane/apps/backend/internal/platform/metrics"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	"github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/email"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/files"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/ntfy"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/presence"
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
	rootContext  context.Context
	pool         *pgxpool.Pool
	processors   []workerProcessor
	logger       *slog.Logger
	startupDelay time.Duration
	checkSchema  func(context.Context) error
	validateOnly bool
	metrics      *platformmetrics.Metrics
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
	workerCtx, cancelWorker := context.WithCancel(ctx)
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		app.run(workerCtx)
	}()
	server := httpserver.New(runtimeConfig.ListenAddress(), httpserver.SecurityHeaders(app.healthHandler(runtimeConfig)))
	serveErr := httpserver.Serve(workerCtx, server, logger, httpserver.DefaultShutdownTimeout)
	cancelWorker()
	<-workerDone
	if serveErr != nil {
		logger.Error("worker health server stopped with error", slog.String("error_code", "server_failed"))
		os.Exit(1)
	}
}

func newApplication(ctx context.Context, runtimeConfig config.WorkspaceConfig, logger *slog.Logger) (*application, error) {
	recorder, err := platformmetrics.New(platformmetrics.Options{})
	if err != nil {
		return nil, err
	}
	app := &application{rootContext: ctx, logger: logger, startupDelay: time.Minute, validateOnly: runtimeConfig.WorkerValidateOnly, metrics: recorder}
	if !runtimeConfig.Enabled || (!runtimeConfig.WorkerValidateOnly && !runtimeConfig.NtfyWorkerEnabled && !runtimeConfig.EmailWorkerEnabled && !runtimeConfig.MaintenanceEnabled && !runtimeConfig.EchoWorkerEnabled) {
		return app, nil
	}
	pool, err := postgres.OpenPoolFromEnv(ctx)
	if err != nil {
		return nil, err
	}
	checker := migrations.SchemaChecker{Queryer: postgres.NewMigrationReadOnlyQueryer(pool), Directory: runtimeConfig.MigrationsDir, AllowReleaseCompatibility: true}
	schemaCtx, cancelSchema := context.WithTimeout(ctx, 10*time.Second)
	report, schemaErr := checker.Check(schemaCtx)
	cancelSchema()
	if schemaErr != nil {
		pool.Close()
		return nil, schemaErr
	}
	checker.Directory, checker.RequiredNames = "", report.RequiredNames
	app.checkSchema = func(ctx context.Context) error {
		_, err := checker.Check(ctx)
		return err
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
		presenceService := presence.NewService(presence.ServiceOptions{Repository: presence.NewPGRepository(pool)})
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
				result, err := service.ProcessJobsWithContextPresence(ctx, presenceService)
				return processResult(result), err
			},
		})
	}
	if runtimeConfig.MaintenanceEnabled {
		presenceService := presence.NewService(presence.ServiceOptions{Repository: presence.NewPGRepository(pool)})
		app.processors = append(app.processors, workerProcessor{
			name: "presence_expiry", interval: time.Minute,
			process: func(ctx context.Context) (processResult, error) {
				_, err := presenceService.SweepExpired(ctx, presence.DefaultSweepBatch)
				return processResult{}, err
			},
		})
		store, err := newMaintenanceBlobStoreWithObservation(ctx, runtimeConfig, platformstorage.ObservationOptions{
			Observer: recorder, Service: platformmetrics.ServiceWorker,
		})
		if err != nil {
			pool.Close()
			return nil, err
		}
		fileService := files.NewService(files.ServiceOptions{
			Repository: files.NewPGRepository(pool), BlobStore: store,
		})
		maintenance := newMaintenanceRunner(fileService, store)
		app.processors = append(app.processors, maintenance.processors()...)
	}
	if runtimeConfig.EchoWorkerEnabled {
		processors, err := newEchoProcessors(pool, &runtimeConfig)
		if err != nil {
			pool.Close()
			return nil, err
		}
		app.processors = append(app.processors, processors...)
	}
	app.pool = pool
	return app, nil
}

func (app *application) run(ctx context.Context) {
	if ctx == nil {
		ctx = context.Background()
	}
	if app == nil {
		<-ctx.Done()
		return
	}
	var wait sync.WaitGroup
	if app.metrics != nil && app.pool != nil {
		wait.Add(1)
		go func() { defer wait.Done(); app.runMetrics(ctx) }()
	}
	processors := app.processors
	if app.validateOnly {
		processors = nil
	}
	for _, configured := range processors {
		processor := configured
		wait.Add(1)
		go func() {
			defer wait.Done()
			app.runProcessor(ctx, processor)
		}()
	}
	if len(processors) == 0 {
		<-ctx.Done()
	}
	wait.Wait()
}

type healthResponse struct {
	Mode    string `json:"mode,omitempty"`
	OK      bool   `json:"ok"`
	Service string `json:"service"`
	State   string `json:"state"`
	Version string `json:"version"`
	Commit  string `json:"commit"`
}

func (app *application) healthHandler(runtimeConfig config.WorkspaceConfig) http.Handler {
	mode := "active"
	if app != nil && app.validateOnly {
		mode = "validate-only"
	}
	router := http.NewServeMux()
	if app != nil && app.metrics != nil {
		// Scraping only reads cached aggregates and pool/process snapshots.
		// Queue SQL belongs to the bounded background collection loop.
		private := app.metrics.Handler()
		router.Handle("/metrics", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if app.pool != nil {
				app.metrics.SetPGPool(platformmetrics.ServiceWorker, platformmetrics.SnapshotFromPGPool(app.pool.Stat()))
			}
			private.ServeHTTP(w, r)
		}))
	}
	router.HandleFunc("GET /healthz", func(response http.ResponseWriter, _ *http.Request) {
		writeHealth(response, http.StatusOK, healthResponse{OK: true, Service: serviceName, State: "live", Version: runtimeConfig.AppVersion, Commit: runtimeConfig.Commit})
	})
	router.HandleFunc("GET /readyz", func(response http.ResponseWriter, request *http.Request) {
		ready := app != nil && (app.pool != nil || len(app.processors) == 0)
		if ready && app.validateOnly && app.pool == nil {
			ready = false
		}
		if ready && app.rootContext != nil && app.rootContext.Err() != nil {
			ready = false
		}
		if ready && app.pool != nil {
			ready = app.schemaReady(request.Context())
		}
		status := http.StatusOK
		state := "ready"
		if !ready {
			status = http.StatusServiceUnavailable
			state = "not_ready"
		}
		writeHealth(response, status, healthResponse{OK: ready, Service: serviceName, State: state, Mode: mode, Version: runtimeConfig.AppVersion, Commit: runtimeConfig.Commit})
	})
	return router
}

func writeHealth(response http.ResponseWriter, status int, payload healthResponse) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
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
	if app == nil || app.validateOnly || processor.process == nil {
		return
	}
	if !app.schemaReady(ctx) {
		if app.logger != nil {
			app.logger.Error("worker schema unavailable", slog.String("error_code", "schema_unavailable"))
		}
		return
	}
	result, err := processor.process(ctx)
	app.metrics.ObserveWorkerResult(platformmetrics.WorkerOperation(processor.name), platformmetrics.WorkerResult{
		Claimed: int64(result.Claimed), Completed: int64(result.Sent), Cancelled: int64(result.Cancelled),
		Retried: int64(result.Retried), Failed: int64(result.Failed),
	})
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

func (app *application) runMetrics(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		if err := collectWorkerBacklog(ctx, app.pool, app.metrics); err != nil && ctx.Err() == nil && app.logger != nil {
			app.logger.Warn("worker metrics unavailable", slog.String("error_code", "metrics_unavailable"))
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (app *application) schemaReady(ctx context.Context) bool {
	if app == nil {
		return false
	}
	if app.checkSchema == nil {
		return app.pool == nil
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return app.checkSchema(ctx) == nil
}
