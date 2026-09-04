package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/timestarry/duallane/apps/backend/internal/platform/migrations"
	"github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
)

const migrationDirectoryEnv = "DUALLANE_MIGRATIONS_DIR"

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "migration failed: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	directory := defaultMigrationDirectory()
	if configured := strings.TrimSpace(os.Getenv(migrationDirectoryEnv)); configured != "" {
		directory = configured
	}
	flag.StringVar(&directory, "migrations-dir", directory, "directory containing canonical numbered SQL migrations")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	db, err := postgres.OpenFromEnv(ctx)
	if err != nil {
		return err
	}
	defer func() {
		_ = db.Close(context.Background())
	}()

	runner := migrations.Runner{
		Beginner:  postgres.NewMigrationBeginner(db),
		Directory: directory,
	}
	result, err := runner.Run(ctx)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stdout, "Applied %d migration(s); discovered %d.\n", result.Applied, result.Discovered)
	return nil
}

func defaultMigrationDirectory() string {
	candidates := []string{
		"../web/server/migrations",
		"apps/web/server/migrations",
		"/app/apps/web/server/migrations",
	}
	for _, candidate := range candidates {
		info, err := os.Stat(candidate)
		if err == nil && info.IsDir() {
			return filepath.Clean(candidate)
		}
	}
	return candidates[0]
}
