package config

import "path/filepath"

// LocalStorageRoot preserves Node's workspaceStorageRoot(dataDir) layout.
// DataDir is the application data directory, not the physical object root.
// This function resolves a path only; provisioning is never implicit here.
func (config WorkspaceConfig) LocalStorageRoot() string {
	return filepath.Join(config.DataDir, "workspace-files")
}
