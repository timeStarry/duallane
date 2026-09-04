package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/timestarry/duallane/apps/backend/internal/p2p"
	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
	"github.com/timestarry/duallane/apps/backend/internal/platform/httpserver"
	"github.com/timestarry/duallane/apps/backend/internal/platform/logging"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		logger := logging.New(logging.Options{Service: "p2p", Writer: os.Stderr})
		logger.Error("invalid p2p configuration", slog.String("error_code", "config_invalid"))
		os.Exit(2)
	}
	logger := logging.New(logging.Options{
		Service: cfgService,
		Version: cfg.AppVersion,
		Commit:  cfg.Commit,
		Writer:  os.Stderr,
	})
	manager := p2p.NewManager(p2p.ManagerOptions{
		RoomTTL:        cfg.RoomTTL,
		EmptyRoomGrace: cfg.EmptyRoomGrace,
	})
	handler := p2p.NewHandler(p2p.HandlerOptions{
		Config:  cfg,
		Manager: manager,
		Logger:  logger,
	})
	defer handler.Close()

	server := httpserver.New(cfg.ListenAddress(), handler.Routes())
	server.RegisterOnShutdown(handler.Close)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := httpserver.Serve(ctx, server, logger, httpserver.DefaultShutdownTimeout); err != nil {
		logger.Error("p2p server stopped with error", slog.String("error_code", "server_failed"))
		os.Exit(1)
	}
}

const cfgService = "p2p"
