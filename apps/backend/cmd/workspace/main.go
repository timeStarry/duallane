package main

import (
	"context"
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
	"github.com/timestarry/duallane/apps/backend/internal/platform/media"
	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	"github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/bootstrap"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/bots"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/conversations"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/email"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/emotes"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/events"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/files"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/httpapi"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/interactions"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/invites"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/members"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messageblocks"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messagejobs"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/ntfy"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/overview"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/realtime"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/topics"
)

const serviceName = "workspace"

type application struct {
	handler        http.Handler
	pool           *pgxpool.Pool
	cancel         context.CancelFunc
	backgroundDone <-chan struct{}
	closeOnce      sync.Once
}

func (app *application) Close() {
	if app == nil {
		return
	}
	app.closeOnce.Do(func() {
		if app.cancel != nil {
			app.cancel()
		}
		if app.backgroundDone != nil {
			<-app.backgroundDone
		}
		if app.pool != nil {
			app.pool.Close()
		}
	})
}

func main() {
	logger := logging.New(logging.Options{Service: serviceName, Writer: os.Stderr})
	config, err := config.LoadWorkspace()
	if err != nil {
		logger.Error("invalid workspace configuration", slog.String("error_code", "config_invalid"))
		os.Exit(2)
	}
	logger = logging.New(logging.Options{
		Service: serviceName, Version: config.AppVersion, Commit: config.Commit, Writer: os.Stderr,
	})
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	app, err := newApplication(ctx, config, logger)
	if err != nil {
		logger.Error("workspace dependencies unavailable", slog.String("error_code", "dependency_unavailable"))
		os.Exit(1)
	}
	defer app.Close()
	server := httpserver.New(config.ListenAddress(), httpserver.SecurityHeaders(app.handler))
	serveErr := httpserver.Serve(ctx, server, logger, httpserver.DefaultShutdownTimeout)
	app.Close()
	if serveErr != nil {
		logger.Error("workspace server stopped with error", slog.String("error_code", "server_failed"))
		os.Exit(1)
	}
}

func newApplication(ctx context.Context, runtimeConfig config.WorkspaceConfig, loggers ...*slog.Logger) (result *application, resultErr error) {
	ctx, cancel := context.WithCancel(ctx)
	defer func() {
		if result == nil {
			cancel()
		}
	}()
	var logger *slog.Logger
	if len(loggers) > 0 {
		logger = loggers[0]
	}
	workspaceGate := gate.New("false")
	if runtimeConfig.Enabled {
		workspaceGate = gate.New("true")
	}
	databaseReady := false
	objectStoreReady := false
	var pool *pgxpool.Pool
	var authHandler *auth.HTTPHandler
	var inviteService *invites.Service
	var memberService *members.Service
	var conversationService *conversations.Service
	var messageService *messages.Service
	var cardService *cards.Service
	var interactionService *interactions.Service
	var overviewService *overview.Service
	var bootstrapService *bootstrap.Service
	var botService *bots.Service
	var fileService *files.Service
	var topicService *topics.Service
	var ntfyService *ntfy.Service
	var emailService *email.Service
	var emoteService *emotes.Service
	var realtimeHandler http.Handler
	var blobStore platformstorage.BlobStore
	var backgroundDone chan struct{}
	var databaseProbe func(context.Context) error
	if runtimeConfig.Enabled {
		var err error
		catalog, err := emotes.LoadCatalogFile(runtimeConfig.EmoteCatalogPath)
		if err != nil {
			return nil, err
		}
		// A single processor bounds native media concurrency across this process.
		processor, err := media.NewProcessor(media.Options{})
		if err != nil {
			return nil, err
		}
		pool, err = postgres.OpenPoolFromEnv(ctx)
		if err != nil {
			return nil, err
		}
		checker := migrations.SchemaChecker{Queryer: postgres.NewMigrationReadOnlyQueryer(pool), Directory: runtimeConfig.MigrationsDir}
		schemaCtx, cancelSchema := context.WithTimeout(ctx, 10*time.Second)
		report, schemaErr := checker.Check(schemaCtx)
		cancelSchema()
		if schemaErr != nil {
			pool.Close()
			return nil, schemaErr
		}
		// Freeze this binary's expected set. Readiness rechecks the database,
		// never applies migrations or rereads a mutable filesystem catalog.
		checker.Directory, checker.RequiredNames = "", report.RequiredNames
		databaseProbe = func(ctx context.Context) error {
			_, err := checker.Check(ctx)
			return err
		}
		databaseReady = true
		github, err := auth.NewGitHubOAuth(auth.GitHubOAuthConfig{
			ClientID: runtimeConfig.GitHubClientID, ClientSecret: runtimeConfig.GitHubClientSecret,
			Timeout: runtimeConfig.GitHubOAuthTimeout, ProxyURL: runtimeConfig.GitHubProxyURL,
		})
		if err != nil {
			pool.Close()
			return nil, err
		}
		authService := auth.NewService(auth.ServiceOptions{Store: auth.NewPGStore(pool)})
		authHandler = auth.NewHTTPHandler(auth.HTTPHandler{
			Service: authService, GitHub: github, Environment: runtimeConfig.Environment,
			PublicBaseURL: runtimeConfig.PublicBaseURL, FrontendURL: runtimeConfig.FrontendURL,
			TrustProxy: runtimeConfig.TrustProxy, WorkspaceEnabled: workspaceGate.Enabled,
		})
		inviteService = invites.NewService(invites.ServiceOptions{Repository: invites.NewPGRepository(pool)})
		botService = bots.NewService(bots.ServiceOptions{Repository: bots.NewPGRepository(pool)})
		memberService = members.NewService(members.ServiceOptions{Repository: members.NewPGRepository(pool)})
		conversationService = conversations.NewService(conversations.ServiceOptions{Repository: conversations.NewPGRepository(pool)})
		blobStore, err = newBlobStore(ctx, runtimeConfig)
		if err != nil {
			pool.Close()
			return nil, err
		}
		objectStoreReady = true
		fileService = files.NewService(files.ServiceOptions{Repository: files.NewPGRepository(pool), BlobStore: blobStore})
		frontendURL := runtimeConfig.FrontendURL
		if frontendURL == "" {
			frontendURL = runtimeConfig.PublicBaseURL
		}
		ntfyRepository := ntfy.NewPGRepository(pool)
		ntfyService, err = ntfy.NewServiceWithError(ntfy.ServiceOptions{
			Repository: ntfyRepository, ServerURL: runtimeConfig.NtfyBaseURL,
			FrontendURL: frontendURL,
		})
		if err != nil {
			pool.Close()
			return nil, err
		}
		emailRepository := email.NewPGRepository(pool)
		emailService, err = email.NewServiceWithError(email.ServiceOptions{
			Repository: emailRepository, FrontendURL: frontendURL,
			EncryptionKeyB64: runtimeConfig.SMTPEncryptionKey,
		})
		if err != nil {
			pool.Close()
			return nil, err
		}
		jobScheduler := messagejobs.NewScheduler(emailService, emailRepository, ntfyService, ntfyRepository)
		topicService = topics.NewService(topics.ServiceOptions{
			Repository: topics.NewPGRepositoryWithMessageJobs(pool, jobScheduler), RequireMessageJobs: true,
		})
		cardRegistry, err := cards.NewRegistry()
		if err != nil {
			pool.Close()
			return nil, err
		}
		cardService = cards.NewService(cards.ServiceOptions{Repository: cards.NewPGRepository(pool), Registry: cardRegistry})
		emoteService = emotes.NewService(emotes.ServiceOptions{
			Repository: emotes.NewPGRepository(pool), BlobStore: blobStore,
			Catalog: catalog, Processor: emoteMediaProcessor{processor: processor},
		})
		messageService = messages.NewService(messages.ServiceOptions{
			Repository: messages.NewPGRepositoryWithMessageJobs(pool, jobScheduler), RequireMessageJobs: true,
			AdvancedBlockValidator: messageblocks.NewValidator(messageblocks.ValidatorOptions{
				Cards: cardService, Emotes: emoteService, Topics: topicService,
			}),
		})
		commandRegistry, err := interactions.NewCommandRegistry()
		if err != nil {
			pool.Close()
			return nil, err
		}
		workflowRegistry, err := interactions.NewWorkflowRegistry()
		if err != nil {
			pool.Close()
			return nil, err
		}
		interactionService = interactions.NewService(interactions.ServiceOptions{
			Repository: interactions.NewPGRepository(pool), CommandRegistry: commandRegistry, WorkflowRegistry: workflowRegistry,
		})
		overviewService = overview.NewService(overview.ServiceOptions{Repository: overview.NewPGRepository(pool)})
		eventHub := realtime.NewHub()
		eventService := events.NewService(events.ServiceOptions{Repository: events.NewPGRepository(pool)})
		bootstrapService = bootstrap.NewService(bootstrap.ServiceOptions{
			Repository: bootstrap.NewPGRepository(pool), Members: memberService,
			Conversations: conversationService, Files: fileService, Events: eventService,
			AppVersion: runtimeConfig.AppVersion,
		})
		realtimeHandler = realtime.NewHandler(realtime.HandlerOptions{
			RootContext: ctx, ActorResolver: authHandler, Events: eventService, Hub: eventHub,
		})
		listener := realtime.NewPGListener(realtime.ListenerOptions{Pool: pool, Hub: eventHub, Logger: logger})
		backgroundDone = make(chan struct{})
		go func() {
			defer close(backgroundDone)
			if err := listener.Run(ctx); err != nil && logger != nil {
				logger.Error("workspace event listener stopped", slog.String("error_code", "listener_failed"))
			}
		}()
	} else {
		authHandler = auth.NewHTTPHandler(auth.HTTPHandler{
			Environment: runtimeConfig.Environment, PublicBaseURL: runtimeConfig.PublicBaseURL,
			FrontendURL: runtimeConfig.FrontendURL, TrustProxy: runtimeConfig.TrustProxy,
			WorkspaceEnabled: workspaceGate.Enabled,
		})
	}

	healthInput := func() gate.HealthInput {
		return gate.HealthInput{
			Service: serviceName, Version: runtimeConfig.AppVersion, Commit: runtimeConfig.Commit,
			Live: ctx.Err() == nil, DatabaseReady: databaseReady, ObjectStoreReady: objectStoreReady || !runtimeConfig.Enabled, Workspace: workspaceGate,
		}
	}
	var storageProbe func(context.Context) error
	if runtimeConfig.Enabled {
		if store, ok := blobStore.(interface{ AssertReady(context.Context) error }); ok {
			storageProbe = store.AssertReady
		}
	}
	return &application{
		pool: pool, cancel: cancel, backgroundDone: backgroundDone,
		handler: httpapi.NewRouter(httpapi.RouterOptions{
			Gate: workspaceGate, Health: gate.HealthHandler(healthInput), Readiness: readinessHandler(healthInput, databaseProbe, storageProbe),
			AuthRoutes: authHandler, ActorResolver: authHandler, Invites: inviteService,
			Members: memberService, Conversations: conversationService, Messages: messageService,
			Cards: cardService, Interactions: interactionService,
			Overview:    overviewService,
			Bootstrap:   bootstrapService,
			Files:       fileService,
			Topics:      topicService,
			Ntfy:        ntfyService,
			Email:       emailService,
			Emotes:      emoteService,
			Bots:        botService,
			Realtime:    realtimeHandler,
			FrontendURL: runtimeConfig.FrontendURL, PublicBaseURL: runtimeConfig.PublicBaseURL,
			TrustProxy: runtimeConfig.TrustProxy,
		}),
	}, nil
}

func newBlobStore(ctx context.Context, runtimeConfig config.WorkspaceConfig) (platformstorage.BlobStore, error) {
	if runtimeConfig.StorageDriver != "s3" {
		return platformstorage.NewLocalBlobStore(runtimeConfig.DataDir)
	}
	credentials, err := config.LoadS3Credentials(runtimeConfig.S3CredentialsFile)
	if err != nil {
		return nil, err
	}
	primary, err := platformstorage.NewS3BlobStore(platformstorage.S3Config{
		Endpoint: runtimeConfig.S3Endpoint, Region: runtimeConfig.S3Region, Bucket: runtimeConfig.S3Bucket,
		AccessKey: credentials.AccessKey, SecretKey: credentials.SecretKey,
	})
	if err != nil {
		return nil, err
	}
	if err := primary.AssertReady(ctx); err != nil {
		return nil, err
	}
	if !runtimeConfig.LocalReadFallback && !runtimeConfig.LocalMirrorWrite {
		return primary, nil
	}
	local, err := platformstorage.NewLocalBlobStore(runtimeConfig.DataDir)
	if err != nil {
		return nil, err
	}
	return platformstorage.NewHybridBlobStore(platformstorage.HybridBlobStoreOptions{
		Primary: primary, Local: local, LocalReadFallback: runtimeConfig.LocalReadFallback,
		LocalMirrorWrite: runtimeConfig.LocalMirrorWrite,
	})
}
