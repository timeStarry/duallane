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
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/httpapi"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/invites"
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
	app, err := newApplication(ctx, config)
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

func newApplication(ctx context.Context, runtimeConfig config.WorkspaceConfig) (*application, error) {
	workspaceGate := gate.New("false")
	if runtimeConfig.Enabled {
		workspaceGate = gate.New("true")
	}
	databaseReady := false
	var pool *pgxpool.Pool
	var authHandler *auth.HTTPHandler
	var inviteService *invites.Service
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
			Live: true, DatabaseReady: databaseReady, ObjectStoreReady: true, Workspace: workspaceGate,
		}
	}
	return &application{
		pool: pool,
		handler: httpapi.NewRouter(httpapi.RouterOptions{
			Gate: workspaceGate, Health: gate.HealthHandler(healthInput), Readiness: gate.ReadinessHandler(healthInput),
			AuthRoutes: authHandler, ActorResolver: authHandler, Invites: inviteService,
			FrontendURL: runtimeConfig.FrontendURL, PublicBaseURL: runtimeConfig.PublicBaseURL,
			TrustProxy: runtimeConfig.TrustProxy,
		}),
	}, nil
}
