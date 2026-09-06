package main

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/platform/config"
	"github.com/timestarry/duallane/apps/backend/internal/platform/storage"
)

func TestWorkerFactoryReadsNodeLocalLayoutWithoutProvisioning(t *testing.T) {
	dataDir := t.TempDir()
	key := "profile-avatars/synthetic-user/synthetic.webp"
	physical := filepath.Join(dataDir, "workspace-files", filepath.FromSlash(key))
	if err := os.MkdirAll(filepath.Dir(physical), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(physical, []byte("synthetic"), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := newMaintenanceBlobStore(context.Background(), config.WorkspaceConfig{StorageDriver: "local", DataDir: dataDir, WorkerValidateOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	reader, ok := store.(storage.LegacyReader)
	if !ok {
		t.Fatal("maintenance factory lost legacy reader")
	}
	opened, err := reader.OpenLegacy(context.Background(), key, 9)
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Body.Close()
	content, err := io.ReadAll(opened.Body)
	if err != nil || string(content) != "synthetic" {
		t.Fatalf("legacy bytes=%q err=%v", content, err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "profile-avatars")); !os.IsNotExist(err) {
		t.Fatalf("factory provisioned wrong root: %v", err)
	}
}
