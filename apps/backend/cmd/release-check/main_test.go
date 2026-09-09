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

func TestCommandProviderCombinesSafeProviderStates(t *testing.T) {
	database := releasecheck.Report{
		ReadOnly:   true,
		Ready:      true,
		SnapshotAt: time.Now().UTC(),
		Blockers:   []releasecheck.Blocker{},
		Writers: releasecheck.WriterObservation{
			Status: releasecheck.ObservationNotProven,
		},
		Provider: releasecheck.ProviderObservation{
			Status: releasecheck.ObservationNotChecked,
		},
	}
	for _, testCase := range []struct {
		name          string
		provider      providerReport
		providerErr   error
		wantCode      int
		wantStatus    string
		wantErrorCode string
	}{
		{
			name:       "local is not applicable",
			provider:   providerReport{Driver: providerDriverLocal, Status: providerStatusNotApplicable, Code: providerCodeNotApplicable, ReadOnly: true},
			wantCode:   0,
			wantStatus: "ready",
		},
		{
			name:       "s3 empty is ready",
			provider:   providerReport{Driver: providerDriverS3, Status: providerStatusReady, Code: "storage.multipart_quiescent", ReadOnly: true},
			wantCode:   0,
			wantStatus: "ready",
		},
		{
			name:          "s3 upload is blocked",
			provider:      providerReport{Driver: providerDriverS3, Status: providerStatusBlocked, Code: "storage.multipart_not_quiescent", ReadOnly: true},
			wantCode:      2,
			wantStatus:    "blocked",
			wantErrorCode: "provider_not_quiescent",
		},
		{
			name:          "s3 failure is failed",
			provider:      providerReport{Driver: providerDriverS3, Status: providerStatusFailed, Code: providerCodeCheckFailed, ReadOnly: true},
			providerErr:   errors.New("https://access:secret@example.invalid/provider-body"),
			wantCode:      1,
			wantStatus:    "failed",
			wantErrorCode: "provider_failed",
		},
		{
			name:          "missing provider observation fails closed",
			provider:      providerReport{},
			wantCode:      1,
			wantStatus:    "failed",
			wantErrorCode: "invalid_provider_observation",
		},
		{
			name:          "unknown driver cannot prove readiness",
			provider:      providerReport{Driver: providerDriverUnknown, Status: providerStatusReady, ReadOnly: true},
			wantCode:      1,
			wantStatus:    "failed",
			wantErrorCode: "provider_failed",
		},
		{
			name:          "unobserved S3 state cannot prove readiness",
			provider:      providerReport{Driver: providerDriverS3, Status: providerStatusNotApplicable, ReadOnly: true},
			wantCode:      1,
			wantStatus:    "failed",
			wantErrorCode: "provider_failed",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			var output, diagnostic bytes.Buffer
			code := runWithProvider(context.Background(), []string{"--check-provider"}, &output, &diagnostic,
				func(context.Context) (releasecheck.Report, error) { return database, nil },
				func(context.Context) (providerReport, error) { return testCase.provider, testCase.providerErr })
			if code != testCase.wantCode {
				t.Fatalf("exit code = %d, want %d", code, testCase.wantCode)
			}
			if strings.Contains(output.String()+diagnostic.String(), "secret") || strings.Contains(output.String(), "example.invalid") {
				t.Fatalf("provider details leaked: %s%s", output.String(), diagnostic.String())
			}
			var result commandReport
			if err := json.Unmarshal(output.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.Scope != "database_and_provider_snapshot" || result.Status != testCase.wantStatus || result.Provider == nil {
				t.Fatalf("unexpected result: %#v", result)
			}
			if result.Snapshot == nil || result.Snapshot.Writers.Status != releasecheck.ObservationNotProven || result.Snapshot.Provider.Status != releasecheck.ObservationNotChecked {
				t.Fatalf("database snapshot lost external-state limitations: %#v", result.Snapshot)
			}
			if testCase.wantErrorCode != "" && result.ErrorCode != testCase.wantErrorCode {
				t.Fatalf("error code = %q, want %q", result.ErrorCode, testCase.wantErrorCode)
			}
		})
	}
}

func TestCommandProviderWaitsForDatabaseReadiness(t *testing.T) {
	database := releasecheck.Report{
		ReadOnly: true,
		Ready:    false,
		Blockers: []releasecheck.Blocker{{Code: releasecheck.BlockerUploadReserved, Count: 1}},
	}
	called := false
	var output, diagnostic bytes.Buffer
	code := runWithProvider(context.Background(), []string{"--check-provider"}, &output, &diagnostic,
		func(context.Context) (releasecheck.Report, error) { return database, nil },
		func(context.Context) (providerReport, error) {
			called = true
			return providerReport{}, nil
		})
	if called || code != 2 {
		t.Fatalf("database-blocked command contacted provider or returned %d", code)
	}
	var result commandReport
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Scope != "database_and_provider_snapshot" || result.Status != "blocked" || result.Provider == nil || result.Provider.Status != providerStatusNotChecked {
		t.Fatalf("unexpected blocked result: %#v", result)
	}
}

func TestCommandWithoutProviderFlagDoesNotContactProvider(t *testing.T) {
	database := releasecheck.Report{
		ReadOnly:   true,
		Ready:      true,
		SnapshotAt: time.Now().UTC(),
		Blockers:   []releasecheck.Blocker{},
		Writers:    releasecheck.WriterObservation{Status: releasecheck.ObservationNotProven},
		Provider:   releasecheck.ProviderObservation{Status: releasecheck.ObservationNotChecked},
	}
	var output, diagnostic bytes.Buffer
	code := runWithProvider(context.Background(), nil, &output, &diagnostic,
		func(context.Context) (releasecheck.Report, error) { return database, nil },
		func(context.Context) (providerReport, error) {
			t.Fatal("default command contacted provider")
			return providerReport{}, nil
		})
	if code != 0 {
		t.Fatalf("default command exit code = %d", code)
	}
	var result commandReport
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Scope != "durable_database_snapshot" || result.Provider != nil {
		t.Fatalf("default command unexpectedly included provider state: %#v", result)
	}
}

func TestCommandProviderHelpDoesNotContactDatabaseOrProvider(t *testing.T) {
	var output, diagnostic bytes.Buffer
	code := runWithProvider(context.Background(), []string{"--help"}, &output, &diagnostic,
		func(context.Context) (releasecheck.Report, error) {
			t.Fatal("help contacted database")
			return releasecheck.Report{}, nil
		},
		func(context.Context) (providerReport, error) {
			t.Fatal("help contacted provider")
			return providerReport{}, nil
		})
	if code != 0 || !strings.Contains(output.String(), "--check-provider") {
		t.Fatalf("help output/code = %d/%q", code, output.String())
	}
}
