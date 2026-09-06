package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/platform/releasecheck"
)

func TestCommandKeepsReadyBlockedAndFailureDistinct(t *testing.T) {
	ready := releasecheck.Report{ReadOnly: true, Ready: true, SnapshotAt: time.Now().UTC(), Blockers: []releasecheck.Blocker{}}
	ready.Writers = releasecheck.WriterObservation{Status: releasecheck.ObservationNotProven}
	ready.Provider = releasecheck.ProviderObservation{Status: releasecheck.ObservationNotChecked}
	blocked := ready
	blocked.Ready = false
	blocked.Blockers = []releasecheck.Blocker{{Code: releasecheck.BlockerEmailSending, Count: 1}}
	for _, tc := range []struct {
		name   string
		report releasecheck.Report
		err    error
		code   int
		status string
	}{
		{"ready", ready, nil, 0, "ready"},
		{"blocked", blocked, nil, 2, "blocked"},
		{"failure", ready, errors.New("postgres://private-secret/private-row"), 1, "failed"},
		{"missing observation", releasecheck.Report{}, nil, 1, "failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var output, diagnostic bytes.Buffer
			code := run(context.Background(), nil, &output, &diagnostic, func(ctx context.Context) (releasecheck.Report, error) {
				deadline, ok := ctx.Deadline()
				if !ok || time.Until(deadline) > commandTimeout {
					t.Fatal("command did not bound observation")
				}
				return tc.report, tc.err
			})
			if code != tc.code || strings.Contains(output.String()+diagnostic.String(), "private-") {
				t.Fatalf("exit code = %d, want %d, or unsafe output", code, tc.code)
			}
			var result commandReport
			if err := json.Unmarshal(output.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.Status != tc.status || result.Scope != "durable_database_snapshot" {
				t.Fatalf("unexpected command status/scope: %s/%s", result.Status, result.Scope)
			}
			if code == 0 && (result.Snapshot.Writers.Status != "not_proven" || result.Snapshot.Provider.Status != "not_checked") {
				t.Fatal("ready database snapshot hid external-state limitations")
			}
		})
	}
}

func TestCommandParsesArgumentsBeforeDatabaseAccess(t *testing.T) {
	for _, tc := range []struct {
		args []string
		code int
	}{
		{[]string{"--help"}, 0},
		{[]string{"--secret-value-not-for-logs"}, 1},
		{[]string{"private-secret-extra"}, 1},
	} {
		var output, diagnostic bytes.Buffer
		code := run(context.Background(), tc.args, &output, &diagnostic, func(context.Context) (releasecheck.Report, error) {
			t.Fatal("argument handling contacted database")
			return releasecheck.Report{}, nil
		})
		if code != tc.code || strings.Contains(output.String()+diagnostic.String(), "secret-") {
			t.Fatalf("unsafe argument handling or exit code: %d", code)
		}
	}
}

func TestCommandPropagatesCancellationWithoutDetails(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var output, diagnostic bytes.Buffer
	code := run(ctx, nil, &output, &diagnostic, func(ctx context.Context) (releasecheck.Report, error) {
		return releasecheck.Report{}, ctx.Err()
	})
	if code != 1 || !strings.Contains(output.String(), `"errorCode":"snapshot_failed"`) {
		t.Fatal("cancelled command did not fail closed")
	}
}
