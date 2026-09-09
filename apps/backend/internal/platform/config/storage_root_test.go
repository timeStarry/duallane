package config

import (
	"path/filepath"
	"testing"
)

func TestWorkspaceLocalStorageRootPreservesNodeLayout(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "application-data")
	if got := (WorkspaceConfig{DataDir: dataDir}).LocalStorageRoot(); got != filepath.Join(dataDir, "workspace-files") {
		t.Fatalf("local root=%q", got)
	}
}
