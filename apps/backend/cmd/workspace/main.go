package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
	"github.com/timestarry/duallane/apps/backend/internal/platform/httpserver"
	"github.com/timestarry/duallane/apps/backend/internal/platform/logging"
	"github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/bootstrap"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/conversations"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/events"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/files"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/httpapi"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/invites"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/members"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/ntfy"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/overview"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/realtime"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/topics"
)

const serviceName = "workspace"

type application struct {
	handler http.Handler
	pool    *pgxpool.Pool
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
	if app.pool != nil {
		defer app.pool.Close()
	}
	server := httpserver.New(config.ListenAddress(), httpserver.SecurityHeaders(app.handler))
	if err := httpserver.Serve(ctx, server, logger, httpserver.DefaultShutdownTimeout); err != nil {
		logger.Error("workspace server stopped with error", slog.String("error_code", "server_failed"))
		os.Exit(1)
	}
}

func newApplication(ctx context.Context, runtimeConfig config.WorkspaceConfig, loggers ...*slog.Logger) (*application, error) {
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
	var overviewService *overview.Service
	var bootstrapService *bootstrap.Service
	var fileService *files.Service
	var topicService *topics.Service
	var ntfyService *ntfy.Service
	var realtimeHandler http.Handler
	if runtimeConfig.Enabled {
		var err error
		pool, err = postgres.OpenPoolFromEnv(ctx)
		if err != nil {
			return nil, err
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
		memberService = members.NewService(members.ServiceOptions{Repository: members.NewPGRepository(pool)})
		conversationService = conversations.NewService(conversations.ServiceOptions{Repository: conversations.NewPGRepository(pool)})
		messageService = messages.NewService(messages.ServiceOptions{Repository: messages.NewPGRepository(pool)})
		overviewService = overview.NewService(overview.ServiceOptions{Repository: overview.NewPGRepository(pool)})
		blobStore, err := newBlobStore(ctx, runtimeConfig)
		if err != nil {
			pool.Close()
			return nil, err
		}
		objectStoreReady = true
		fileService = files.NewService(files.ServiceOptions{Repository: files.NewPGRepository(pool), BlobStore: blobStore})
		topicService = topics.NewService(topics.ServiceOptions{Repository: topics.NewPGRepository(pool)})
		ntfyFrontendURL := runtimeConfig.FrontendURL
		if ntfyFrontendURL == "" {
			ntfyFrontendURL = runtimeConfig.PublicBaseURL
		}
		ntfyService, err = ntfy.NewServiceWithError(ntfy.ServiceOptions{
			Repository: ntfy.NewPGRepository(pool), ServerURL: runtimeConfig.NtfyBaseURL,
			FrontendURL: ntfyFrontendURL,
		})
		if err != nil {
			pool.Close()
			return nil, err
		}
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
		go func() {
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
			Live: true, DatabaseReady: databaseReady, ObjectStoreReady: objectStoreReady || !runtimeConfig.Enabled, Workspace: workspaceGate,
		}
	}
	return &application{
		pool: pool,
		handler: httpapi.NewRouter(httpapi.RouterOptions{
			Gate: workspaceGate, Health: gate.HealthHandler(healthInput), Readiness: gate.ReadinessHandler(healthInput),
			AuthRoutes: authHandler, ActorResolver: authHandler, Invites: inviteService,
			Members: memberService, Conversations: conversationService, Messages: messageService,
			Overview:    overviewService,
			Bootstrap:   bootstrapService,
			Files:       fileService,
			Topics:      topicService,
			Ntfy:        ntfyService,
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
