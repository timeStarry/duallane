//go:build postgres_integration

package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
)

func assertPassiveWorkerComposition(t *testing.T, ctx context.Context, dsn, migrationDir string) {
	t.Helper()
	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	query.Set("default_transaction_read_only", "on")
	parsed.RawQuery = query.Encode()
	t.Setenv("DATABASE_URL", parsed.String())
	dataDir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dataDir, "workspace-files"), 0o700); err != nil {
		t.Fatal(err)
	}
	app, err := newApplication(ctx, config.WorkspaceConfig{
		Enabled: true, WorkerValidateOnly: true, NtfyWorkerEnabled: true, EmailWorkerEnabled: true, MaintenanceEnabled: true, EchoWorkerEnabled: true,
		MigrationsDir: migrationDir, StorageDriver: "local", DataDir: dataDir, NtfyBaseURL: "https://candidate.invalid",
		ReleaseCatalogPath: filepath.Join(migrationDir, "../../shared/echo-release-guides.json"),
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer app.pool.Close()
	if len(app.processors) != 8 {
		t.Fatalf("expected all eight configured processors, got %d", len(app.processors))
	}
	for _, processor := range app.processors {
		app.tick(ctx, processor)
	}
	var status string
	if err := app.pool.QueryRow(ctx, `SELECT status FROM workspace_email_jobs WHERE id='worker-job'`).Scan(&status); err != nil || status != "pending" {
		t.Fatalf("validate-only changed job status=%s err=%v", status, err)
	}
	w := httptest.NewRecorder()
	app.healthHandler(config.WorkspaceConfig{}).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"mode":"validate-only"`) {
		t.Fatalf("candidate readiness=%d %s", w.Code, w.Body.String())
	}
}
