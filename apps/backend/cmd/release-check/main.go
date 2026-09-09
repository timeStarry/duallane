// Command release-check observes durable PostgreSQL drain blockers. By default
// it does not contact providers; an explicit --check-provider performs one
// read-only multipart observation after a ready database snapshot. It never
// migrates, cleans up, claims jobs, or fences other writers.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/platform/postgres"
	"github.com/timestarry/duallane/apps/backend/internal/platform/releasecheck"
)

const commandTimeout = 10 * time.Second

type observation func(context.Context) (releasecheck.Report, error)

type providerObservation func(context.Context) (providerReport, error)

type commandReport struct {
	Schema    string               `json:"schema"`
	Status    string               `json:"status"`
	Scope     string               `json:"scope"`
	ErrorCode string               `json:"errorCode,omitempty"`
	Snapshot  *releasecheck.Report `json:"snapshot,omitempty"`
	Provider  *providerReport      `json:"provider,omitempty"`
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := runWithProvider(ctx, os.Args[1:], os.Stdout, os.Stderr, observeDatabase, observeConfiguredProvider)
	stop()
	os.Exit(code)
}

func run(ctx context.Context, args []string, output, diagnostic io.Writer, observe observation) int {
	return runWithProvider(ctx, args, output, diagnostic, observe, nil)
}

func runWithProvider(ctx context.Context, args []string, output, diagnostic io.Writer, observe observation, observeProvider providerObservation) int {
	flags := flag.NewFlagSet("duallane-release-check", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	checkProvider := flags.Bool("check-provider", false, "read-only object-storage multipart observation after a ready database snapshot")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			_, err = fmt.Fprintln(output, "Usage: duallane-release-check [--check-provider]\nRead-only PostgreSQL snapshot using DATABASE_URL or PG*. --check-provider observes configured S3 multipart state only after the database snapshot is ready. Exit 0: ready; 2: blocked; 1: failure. This command does not fence writers.")
			if err == nil {
				return 0
			}
		}
		fmt.Fprintln(diagnostic, "release-check: invalid arguments or output unavailable")
		return 1
	}
	if flags.NArg() != 0 || ctx == nil || observe == nil {
		fmt.Fprintln(diagnostic, "release-check: invalid input")
		return 1
	}
	bounded, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	snapshot, err := observe(bounded)
	scope := "durable_database_snapshot"
	if *checkProvider {
		scope = "database_and_provider_snapshot"
	}
	report := commandReport{Schema: "duallane.release-check/v1", Scope: scope, Status: "failed"}
	code := 1
	if err != nil {
		// Connection/SQL errors can contain credentials or row values. Only a
		// fixed category crosses the command boundary, never the original error.
		report.ErrorCode = "snapshot_failed"
	} else if !snapshot.ReadOnly {
		report.ErrorCode = "invalid_snapshot"
	} else {
		report.Snapshot = &snapshot
		databaseReady := snapshot.Ready && len(snapshot.Blockers) == 0 && !snapshot.SnapshotAt.IsZero()
		if !databaseReady {
			report.Status, code = "blocked", 2
			if *checkProvider {
				report.Provider = &providerReport{
					Driver:   providerDriverUnknown,
					Status:   providerStatusNotChecked,
					Code:     providerCodeDatabaseNotReady,
					ReadOnly: true,
				}
			}
		} else if !*checkProvider {
			report.Status, code = "ready", 0
		} else if observeProvider == nil {
			report.ErrorCode = "provider_observer_unavailable"
			report.Provider = &providerReport{
				Driver:   providerDriverUnknown,
				Status:   providerStatusFailed,
				Code:     providerCodeCheckFailed,
				ReadOnly: true,
			}
		} else {
			provider, providerErr := observeProvider(bounded)
			report.Provider = &provider
			if providerErr != nil {
				report.ErrorCode = "provider_failed"
				provider.Status = providerStatusFailed
				if provider.Code == "" {
					provider.Code = providerCodeCheckFailed
				}
				report.Provider = &provider
			} else {
				switch {
				case !provider.ReadOnly:
					report.ErrorCode = "invalid_provider_observation"
					provider.Status = providerStatusFailed
					provider.Code = providerCodeCheckFailed
					report.Provider = &provider
				case provider.Driver == providerDriverLocal && provider.Status == providerStatusNotApplicable:
					report.Status, code = "ready", 0
				case provider.Driver == providerDriverS3 && provider.Status == providerStatusReady:
					report.Status, code = "ready", 0
				case provider.Driver == providerDriverS3 && provider.Status == providerStatusBlocked:
					report.Status, code = "blocked", 2
					report.ErrorCode = "provider_not_quiescent"
				default:
					report.Status, code = "failed", 1
					report.ErrorCode = "provider_failed"
					provider.Status = providerStatusFailed
					if provider.Code == "" {
						provider.Code = providerCodeCheckFailed
					}
					report.Provider = &provider
				}
			}
		}
	}
	if err := json.NewEncoder(output).Encode(report); err != nil {
		fmt.Fprintln(diagnostic, "release-check: output unavailable")
		return 1
	}
	return code
}

func observeDatabase(ctx context.Context) (releasecheck.Report, error) {
	dsn, err := postgres.ResolveDSN(os.LookupEnv)
	if err != nil {
		return releasecheck.Report{}, err
	}
	// This one-shot observer cannot multiply the configured application pool.
	pool, err := postgres.OpenPool(ctx, dsn, postgres.PoolOptions{MaxConnections: 1})
	if err != nil {
		return releasecheck.Report{}, err
	}
	defer pool.Close()
	return releasecheck.Check(ctx, pool)
}
