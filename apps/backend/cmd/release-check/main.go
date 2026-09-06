// Command release-check observes durable PostgreSQL drain blockers. It does
// not migrate, clean up, claim jobs, contact providers, or fence other writers.
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

type commandReport struct {
	Schema    string               `json:"schema"`
	Status    string               `json:"status"`
	Scope     string               `json:"scope"`
	ErrorCode string               `json:"errorCode,omitempty"`
	Snapshot  *releasecheck.Report `json:"snapshot,omitempty"`
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := run(ctx, os.Args[1:], os.Stdout, os.Stderr, observeDatabase)
	stop()
	os.Exit(code)
}

func run(ctx context.Context, args []string, output, diagnostic io.Writer, observe observation) int {
	flags := flag.NewFlagSet("duallane-release-check", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			_, err = fmt.Fprintln(output, "Usage: duallane-release-check\nRead-only PostgreSQL snapshot using DATABASE_URL or PG*. Exit 0: durable snapshot ready; 2: blocked; 1: failure. Writer fencing and provider state must be verified separately.")
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
	report := commandReport{Schema: "duallane.release-check/v1", Scope: "durable_database_snapshot", Status: "failed"}
	code := 1
	if err != nil {
		// Connection/SQL errors can contain credentials or row values. Only a
		// fixed category crosses the command boundary, never the original error.
		report.ErrorCode = "snapshot_failed"
	} else if !snapshot.ReadOnly {
		report.ErrorCode = "invalid_snapshot"
	} else {
		report.Snapshot = &snapshot
		report.Status, code = "blocked", 2
		if snapshot.Ready && len(snapshot.Blockers) == 0 && !snapshot.SnapshotAt.IsZero() {
			report.Status, code = "ready", 0
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
