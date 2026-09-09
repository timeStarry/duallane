package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
	platformmetrics "github.com/timestarry/duallane/apps/backend/internal/platform/metrics"
	"github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

func TestStorageFactoryObservesOnlyOutermostStore(t *testing.T) {
	for _, provider := range []string{"local", "s3", "hybrid"} {
		for _, passive := range []bool{false, true} {
			name := provider
			if passive {
				name += "-passive"
			}
			t.Run(name, func(t *testing.T) {
				ctx := context.Background()
				dataDir := t.TempDir()
				if err := os.Mkdir(filepath.Join(dataDir, "workspace-files"), 0o700); err != nil {
					t.Fatal(err)
				}
				credentialPath := filepath.Join(t.TempDir(), "synthetic-credentials.json")
				if err := os.WriteFile(credentialPath, []byte(`{"accessKey":"synthetic-access","secretKey":"synthetic-secret"}`), 0o600); err != nil {
					t.Fatal(err)
				}
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Method != http.MethodHead || r.URL.Path != "/synthetic-bucket" {
						t.Errorf("unexpected provider request %s %s", r.Method, r.URL.Path)
						w.WriteHeader(http.StatusInternalServerError)
						return
					}
					w.WriteHeader(http.StatusOK)
				}))
				defer server.Close()
				cfg := config.WorkspaceConfig{
					DataDir: dataDir, StorageDriver: provider, CandidateHealthOnly: passive,
					S3CredentialsFile: credentialPath, S3Endpoint: server.URL, S3Region: "us-east-1", S3Bucket: "synthetic-bucket",
				}
				if provider == "hybrid" {
					cfg.StorageDriver = "s3"
					cfg.LocalReadFallback, cfg.LocalMirrorWrite = true, true
				}
				recorder, err := platformmetrics.New(platformmetrics.Options{})
				if err != nil {
					t.Fatal(err)
				}
				store, err := newBlobStoreWithObservation(ctx, cfg, storage.ObservationOptions{Observer: recorder, Service: platformmetrics.ServiceWorkspace})
				if err != nil {
					t.Fatal(err)
				}
				if _, ok := store.(storage.LegacyReader); !ok {
					t.Fatal("lost legacy reader")
				}
				if _, ok := store.(storage.UploadAttemptMaintenance); !ok {
					t.Fatal("lost upload cleanup")
				}
				if _, err := store.Open(ctx, storage.Object{Key: "../private-request-secret", ByteSize: 1}, 1); err == nil {
					t.Fatal("invalid key accepted")
				}
				response := httptest.NewRecorder()
				recorder.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/metrics", nil))
				metrics := response.Body.String()
				expected := `duallane_workspace_object_operations_total{operation="open",outcome="failure",service="workspace"} 1`
				if response.Code != http.StatusOK || !strings.Contains(metrics, "\n"+expected+"\n") {
					t.Fatalf("missing exact outermost counter %s (status %d)", expected, response.Code)
				}
				for _, sensitive := range []string{"private-request-secret", "synthetic-access", "synthetic-secret", server.URL, dataDir} {
					if strings.Contains(metrics, sensitive) {
						t.Fatal("storage metrics leaked private configuration")
					}
				}
			})
		}
	}
}
