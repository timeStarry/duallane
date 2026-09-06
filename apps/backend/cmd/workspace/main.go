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
	"github.com/timestarry/duallane/apps/backend/internal/workspace/avatars"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/bootstrap"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/botgateway"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/bots"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/conversations"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/automation"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/carddefinitions"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/delivery"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/releases"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
	echoruntime "github.com/timestarry/duallane/apps/backend/internal/workspace/echo/runtime"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/solicitations"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/email"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/emotes"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/events"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/feishucards"
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
	"github.com/timestarry/duallane/apps/backend/internal/workspace/presence"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/realtime"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/topics"
)

const serviceName = "workspace"

// catalogBuiltinEmoteSource is a composition-only read adapter. The emotes
// domain remains the owner of catalog visibility and image validation; message
// and event projections receive only the already-public source URL.
type catalogBuiltinEmoteSource struct {
	catalog *emotes.Catalog
}

func (source catalogBuiltinEmoteSource) ResolveBuiltinEmote(_ context.Context, emoteKey string) (string, bool) {
	item, ok := source.catalog.Image(emoteKey)
	if !ok {
		return "", false
	}
	return item.Src, true
}

func (source catalogBuiltinEmoteSource) IsVisibleReactionEmote(_ context.Context, emoteKey string) (bool, error) {
	return source.catalog.IsVisible(emoteKey), nil
}

func (source catalogBuiltinEmoteSource) IsKnownReactionEmote(_ context.Context, emoteKey string) (bool, error) {
	_, exists := source.catalog.Lookup(emoteKey)
	return exists, nil
}

type application struct {
	handler            http.Handler
	pool               *pgxpool.Pool
	cancel             context.CancelFunc
	backgroundDone     <-chan struct{}
	closeOnce          sync.Once
	shutdownBotGateway func(context.Context) error
	logger             *slog.Logger
}

func (app *application) Close() {
	if app == nil {
		return
	}
	app.closeOnce.Do(func() {
		if app.cancel != nil {
			app.cancel()
		}
		// WebSocket handlers outlive net/http Shutdown after hijacking. Their
		// nonce-scoped durable cleanup must finish while the pool remains open.
		if app.shutdownBotGateway != nil {
			ctx, cancel := context.WithTimeout(context.Background(), httpserver.DefaultShutdownTimeout)
			if err := app.shutdownBotGateway(ctx); err != nil && app.logger != nil {
				app.logger.Error("workspace bot gateway cleanup failed", slog.String("error_code", "gateway_shutdown_failed"))
			}
			cancel()
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
	var avatarService *avatars.Service
	var conversationService *conversations.Service
	var messageService *messages.Service
	var cardService *cards.Service
	var interactionService *interactions.Service
	var overviewService *overview.Service
	var bootstrapService *bootstrap.Service
	var botService *bots.Service
	var botGatewayService *botgateway.Service
	var botGatewayWebSocket *botgateway.WebSocketHandler
	var fileService *files.Service
	var topicService *topics.Service
	var ntfyService *ntfy.Service
	var emailService *email.Service
	var emoteService *emotes.Service
	var echoRequirements *requirements.Service
	var echoSolicitations *solicitations.Service
	var echoReleases *releases.Service
	var echoDelivery *delivery.Service
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
		releaseCatalog, err := releases.LoadGuideCatalog(runtimeConfig.ReleaseCatalogPath)
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
		authService := auth.NewService(auth.ServiceOptions{Store: echoruntime.AuthStoreHooks{
			AuthenticationStore: auth.NewPGStore(pool), SpaceID: auth.DefaultSpaceID,
			Delivery: func() echoruntime.MemberDelivery {
				if echoDelivery == nil {
					return nil
				}
				return echoDelivery
			},
		}})
		authHandler = auth.NewHTTPHandler(auth.HTTPHandler{
			Service: authService, GitHub: github, Environment: runtimeConfig.Environment,
			PublicBaseURL: runtimeConfig.PublicBaseURL, FrontendURL: runtimeConfig.FrontendURL,
			TrustProxy: runtimeConfig.TrustProxy, WorkspaceEnabled: workspaceGate.Enabled,
		})
		builtinEmoteSource := catalogBuiltinEmoteSource{catalog: catalog}
		inviteService = invites.NewService(invites.ServiceOptions{Repository: invites.NewPGRepository(pool)})
		botRepository := bots.NewPGRepository(pool)
		botService = bots.NewService(bots.ServiceOptions{
			Repository: botRepository, ConnectionProvider: bots.NewRepositoryConnectionProvider(botRepository),
		})
		memberService = members.NewService(members.ServiceOptions{Repository: members.NewPGRepository(pool)})
		messageShareReader := messages.NewPGRepository(pool)
		messageShareReader.SetBuiltinEmoteSource(builtinEmoteSource)
		requirementRepository := requirements.NewPGRepository(pool)
		echoRequirements = requirements.NewService(requirements.ServiceOptions{Repository: requirementRepository})
		solicitationRepository := solicitations.NewPGRepository(pool)
		echoSolicitations = solicitations.NewService(solicitations.ServiceOptions{
			Repository: solicitationRepository, ConversationAccess: messageShareReader,
			Requirements: echoRequirements,
		})
		releaseRepository := releases.NewPGRepository(pool)
		echoReleases, err = releases.NewService(releases.ServiceOptions{Repository: releaseRepository, Catalog: releaseCatalog})
		if err != nil {
			pool.Close()
			return nil, err
		}
		conversationService = conversations.NewService(conversations.ServiceOptions{
			Repository:         conversations.NewPGRepository(pool),
			MessageShareReader: messageShareReader,
		})
		blobStore, err = newBlobStore(ctx, runtimeConfig)
		if err != nil {
			pool.Close()
			return nil, err
		}
		objectStoreReady = true
		fileService = files.NewService(files.ServiceOptions{Repository: files.NewPGRepository(pool), BlobStore: blobStore})
		legacyAvatarReader, _ := blobStore.(avatars.LegacyObjectReader)
		avatarService = avatars.NewService(avatars.ServiceOptions{
			Repository: avatars.NewPGRepository(pool), BlobStore: blobStore,
			LegacyReader: legacyAvatarReader, Processor: processor,
		})
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
		topicRepository := topics.NewPGRepositoryWithMessageJobs(pool, jobScheduler)
		topicService = topics.NewService(topics.ServiceOptions{
			Repository: topicRepository, RequireMessageJobs: true,
		})
		cardDefinitions := append(topics.CardDefinitions(), feishucards.AsCardsDefinition())
		cardDefinitions = append(cardDefinitions, carddefinitions.CardDefinitions(carddefinitions.Options{
			Requirements: echoRequirements, Solicitations: echoSolicitations,
		})...)
		cardRegistry, err := cards.NewRegistry(cardDefinitions...)
		if err != nil {
			pool.Close()
			return nil, err
		}
		cardRepository := cards.NewPGRepository(pool)
		cardService = cards.NewService(cards.ServiceOptions{
			Repository: echoruntime.NewCardRepository(pool, cardRepository, requirementRepository, solicitationRepository), Registry: cardRegistry,
		})
		emoteService = emotes.NewService(emotes.ServiceOptions{
			Repository: emotes.NewPGRepository(pool), BlobStore: blobStore,
			Catalog: catalog, Processor: emoteMediaProcessor{processor: processor},
		})
		messageRepository := messages.NewPGRepositoryWithMessageJobs(pool, jobScheduler)
		messageRepository.SetBuiltinEmoteSource(builtinEmoteSource)
		messageRepository.SetTopicRepository(topicRepository)
		messageService = messages.NewService(messages.ServiceOptions{
			Repository: messageRepository, RequireMessageJobs: true,
			ReactionEmoteValidator: builtinEmoteSource,
			GroupTopicCreator:      messageblocks.NewGroupTopicCreator(topicService, topics.DefaultSpaceID),
			AdvancedBlockValidator: messageblocks.NewValidator(messageblocks.ValidatorOptions{
				Cards: cardService, Emotes: emoteService, Topics: topicService,
			}),
		})
		// Bot identities enter only through the scoped Gateway. Keep the human
		// API's service closed to bots, and do not install inline topic creation
		// on this separate, transaction-bound writer.
		botMessageService := messages.NewService(messages.ServiceOptions{
			Repository: messageRepository, RequireMessageJobs: true, AllowBots: true,
			AdvancedBlockValidator: messageblocks.NewValidator(messageblocks.ValidatorOptions{
				Cards: cardService, Emotes: emoteService, Topics: topicService,
			}),
		})
		runtimeAdapters := botgateway.NewRuntimeAdapters(botgateway.RuntimeAdapterOptions{
			Bots: botService, Messages: botMessageService, Cards: cardService, Files: fileService,
		})
		botGatewayRepository := botgateway.NewPGRepositoryWithDomainTransactions(pool, botgateway.DomainTransactionOptions{
			Messages: messageRepository, Cards: cardRepository,
		})
		botGatewayService = botgateway.NewService(botgateway.ServiceOptions{
			Repository:       botGatewayRepository,
			Authenticator:    runtimeAdapters.TokenAuthenticator,
			MessageWriter:    runtimeAdapters.MessageWriter,
			CardGateway:      runtimeAdapters.CardGateway,
			AttachmentWriter: runtimeAdapters.AttachmentWriter,
			SpaceID:          botgateway.DefaultSpaceID,
		})
		botGatewayWebSocket = botgateway.NewWebSocketHandler(botgateway.WebSocketHandlerOptions{
			RootContext: ctx, Gateway: botGatewayService, SpaceID: botgateway.DefaultSpaceID,
		})
		echoDelivery, err = echoruntime.NewDeliveryService(echoruntime.DeliveryOptions{
			Pool: pool, Messages: messageRepository, Cards: cardRepository, CardService: cardService,
			Requirements: echoRequirements, Solicitations: echoSolicitations, Releases: echoReleases,
		})
		if err != nil {
			pool.Close()
			return nil, err
		}
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
			Repository: automation.NewPGRepository(pool, automation.PGRepositoryOptions{
				InteractionRepository: interactions.NewPGRepository(pool), RequirementsRepository: requirementRepository,
				SolicitationsRepository: solicitationRepository, ReleasesRepository: releaseRepository,
			}), CommandRegistry: commandRegistry, WorkflowRegistry: workflowRegistry,
		})
		echoAutomation := automation.OptionsForServices(echoRequirements, echoSolicitations, echoReleases, interactionService, time.Now)
		for _, definition := range automation.NewCommandDefinitions(echoAutomation) {
			if _, err := commandRegistry.Register(definition); err != nil {
				pool.Close()
				return nil, err
			}
		}
		for _, definition := range automation.NewWorkflowDefinitions(echoAutomation) {
			if _, err := workflowRegistry.Register(definition); err != nil {
				pool.Close()
				return nil, err
			}
		}
		overviewService = overview.NewService(overview.ServiceOptions{Repository: overview.NewPGRepository(pool)})
		eventHub := realtime.NewHub()
		eventRepository := events.NewPGRepository(pool)
		eventRepository.SetBuiltinEmoteSource(builtinEmoteSource)
		eventService := events.NewService(events.ServiceOptions{Repository: eventRepository})
		presenceService := presence.NewService(presence.ServiceOptions{Repository: presence.NewPGRepository(pool)})
		bootstrapService = bootstrap.NewService(bootstrap.ServiceOptions{
			Repository: bootstrap.NewPGRepository(pool), Members: memberService,
			Conversations: conversationService, Files: fileService, Events: eventService,
			AppVersion: runtimeConfig.AppVersion,
		})
		realtimeHandler = realtime.NewHandler(realtime.HandlerOptions{
			RootContext: ctx, ActorResolver: authHandler, Events: eventService, Hub: eventHub,
			Presence: presenceService,
		})
		if !runtimeConfig.CandidateHealthOnly {
			listener := realtime.NewPGListener(realtime.ListenerOptions{Pool: pool, Hub: eventHub, Logger: logger})
			backgroundDone = make(chan struct{})
			go func() {
				defer close(backgroundDone)
				if err := listener.Run(ctx); err != nil && logger != nil {
					logger.Error("workspace event listener stopped", slog.String("error_code", "listener_failed"))
				}
			}()
		}
	} else {
		authHandler = auth.NewHTTPHandler(auth.HTTPHandler{
			Environment: runtimeConfig.Environment, PublicBaseURL: runtimeConfig.PublicBaseURL,
			FrontendURL: runtimeConfig.FrontendURL, TrustProxy: runtimeConfig.TrustProxy,
			WorkspaceEnabled: workspaceGate.Enabled,
		})
	}

	healthInput := func() gate.HealthInput {
		mode := "active"
		if runtimeConfig.CandidateHealthOnly {
			mode = "candidate-health-only"
		}
		return gate.HealthInput{
			Mode:    mode,
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
	if runtimeConfig.CandidateHealthOnly {
		// Compose the full dependency graph above, but install no business
		// handlers, WebSockets or background tasks on a production candidate.
		return &application{pool: pool, cancel: cancel, logger: logger, handler: candidateHealthRouter(
			gate.HealthHandler(healthInput), readinessHandler(healthInput, databaseProbe, storageProbe),
		)}, nil
	}
	return &application{
		pool: pool, cancel: cancel, backgroundDone: backgroundDone,
		shutdownBotGateway: botGatewayWebSocket.Shutdown, logger: logger,
		handler: httpapi.NewRouter(httpapi.RouterOptions{
			Gate: workspaceGate, Health: gate.HealthHandler(healthInput), Readiness: readinessHandler(healthInput, databaseProbe, storageProbe),
			AuthRoutes: authHandler, ActorResolver: authHandler, Invites: inviteService,
			Members: echoruntime.MemberHooks{Service: memberService, Delivery: echoDelivery, SpaceID: auth.DefaultSpaceID}, Conversations: conversationService, Messages: messageService,
			Avatars:             avatarService,
			Cards:               echoruntime.CardHooks{CardService: cardService, Delivery: echoDelivery, SpaceID: auth.DefaultSpaceID},
			Interactions:        echoruntime.InteractionHooks{InteractionService: interactionService, Delivery: echoDelivery, Finalizer: interactionService, PublicationReader: echoReleases, SpaceID: auth.DefaultSpaceID},
			Overview:            overviewService,
			Bootstrap:           bootstrapService,
			Files:               fileService,
			Topics:              topicService,
			Ntfy:                ntfyService,
			Email:               emailService,
			Emotes:              emoteService,
			EchoRequirements:    echoRequirements,
			EchoSolicitations:   echoSolicitations,
			EchoDelivery:        echoDelivery,
			Bots:                botService,
			BotGateway:          botGatewayService,
			BotGatewaySetup:     botService,
			BotGatewayWebSocket: botGatewayWebSocket,
			Realtime:            realtimeHandler,
			FrontendURL:         runtimeConfig.FrontendURL, PublicBaseURL: runtimeConfig.PublicBaseURL,
			TrustProxy: runtimeConfig.TrustProxy,
		}),
	}, nil
}

func newBlobStore(ctx context.Context, runtimeConfig config.WorkspaceConfig) (platformstorage.BlobStore, error) {
	newLocal := func() (*platformstorage.LocalBlobStore, error) {
		if runtimeConfig.CandidateHealthOnly {
			return platformstorage.OpenExistingLocalBlobStore(ctx, runtimeConfig.DataDir)
		}
		return platformstorage.NewLocalBlobStore(runtimeConfig.DataDir)
	}
	if runtimeConfig.StorageDriver != "s3" {
		return newLocal()
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
	local, err := newLocal()
	if err != nil {
		return nil, err
	}
	return platformstorage.NewHybridBlobStore(platformstorage.HybridBlobStoreOptions{
		Primary: primary, Local: local, LocalReadFallback: runtimeConfig.LocalReadFallback,
		LocalMirrorWrite: runtimeConfig.LocalMirrorWrite,
	})
}
