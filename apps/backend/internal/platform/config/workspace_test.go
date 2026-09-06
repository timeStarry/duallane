package config

import (
	"testing"
	"time"
)

func TestLoadWorkspaceIsDisabledUnlessValueIsExactlyTrue(t *testing.T) {
	for _, value := range []string{"", "false", "TRUE", " true ", "1"} {
		config, err := LoadWorkspaceFrom(configLookup(map[string]string{WorkspaceEnabledEnvironment: value}))
		if err != nil {
			t.Fatal(err)
		}
		if config.Enabled {
			t.Fatalf("WORKSPACE_ENABLED=%q enabled Workspace", value)
		}
	}
	config, err := LoadWorkspaceFrom(configLookup(map[string]string{WorkspaceEnabledEnvironment: "true"}))
	if err != nil {
		t.Fatal(err)
	}
	if !config.Enabled {
		t.Fatal("WORKSPACE_ENABLED=true did not enable Workspace")
	}
}

func TestLoadWorkspacePreservesRuntimeCompatibility(t *testing.T) {
	config, err := LoadWorkspaceFrom(configLookup(map[string]string{
		"HOST":                        "127.0.0.1",
		"PORT":                        "9010",
		"NODE_ENV":                    "production",
		"DUALLANE_APP_VERSION":        "0.16.0",
		"DUALLANE_GIT_COMMIT":         "abc123",
		"PUBLIC_BASE_URL":             "https://duallane.example",
		WorkspaceFrontendEnvironment:  "https://duallane.example/workspace",
		"TRUST_PROXY":                 "true",
		"GITHUB_CLIENT_ID":            "client",
		"GITHUB_CLIENT_SECRET":        "secret",
		"GITHUB_PROXY_URL":            "socks5://proxy:1080",
		GitHubOAuthTimeoutEnvironment: "25000",
		WorkspaceDataDirEnvironment:   "/srv/duallane-data",
		WorkspaceEmoteCatalogEnv:      "/app/assets/emote-packs.json",
		WorkspaceMigrationsDirEnv:     "/app/migrations",
		WorkspaceNtfyBaseEnvironment:  "https://ntfy.example.test",
		WorkspaceNtfyWorkerEnabled:    "false",
		WorkspaceEmailWorkerEnabled:   "false",
		WorkspaceSMTPEncryptionKey:    "smtp-encryption-key",
		WorkspaceStorageDriverEnv:     "s3",
		WorkspaceS3EndpointEnv:        "http://minio:9000",
		WorkspaceS3BucketEnv:          "duallane",
		WorkspaceS3RegionEnv:          "cn-test-1",
		WorkspaceS3CredentialsFileEnv: "/run/secrets/workspace-s3",
		WorkspaceLocalReadFallbackEnv: "true",
		WorkspaceLocalMirrorWriteEnv:  "true",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if config.ListenAddress() != "127.0.0.1:9010" || config.Environment != "production" || config.AppVersion != "0.16.0" || config.Commit != "abc123" || config.DataDir != "/srv/duallane-data" {
		t.Fatalf("runtime config = %#v", config)
	}
	if !config.TrustProxy || config.GitHubOAuthTimeout != 25*time.Second || config.GitHubClientID != "client" || config.GitHubClientSecret != "secret" {
		t.Fatalf("dependency config = %#v", config)
	}
	if config.NtfyBaseURL != "https://ntfy.example.test" {
		t.Fatalf("ntfy base URL = %q", config.NtfyBaseURL)
	}
	if config.EmoteCatalogPath != "/app/assets/emote-packs.json" {
		t.Fatalf("emote catalog path = %q", config.EmoteCatalogPath)
	}
	if config.MigrationsDir != "/app/migrations" {
		t.Fatalf("migrations directory = %q", config.MigrationsDir)
	}
	if config.NtfyWorkerEnabled {
		t.Fatal("WORKSPACE_NTFY_WORKER_ENABLED=false did not disable ntfy worker")
	}
	if config.EmailWorkerEnabled || config.SMTPEncryptionKey != "smtp-encryption-key" {
		t.Fatalf("email worker config = enabled:%v key:%q", config.EmailWorkerEnabled, config.SMTPEncryptionKey)
	}
	if config.StorageDriver != "s3" || config.S3Endpoint != "http://minio:9000" || config.S3Bucket != "duallane" || config.S3Region != "cn-test-1" || config.S3CredentialsFile != "/run/secrets/workspace-s3" {
		t.Fatalf("storage config = %#v", config)
	}
	if !config.LocalReadFallback || !config.LocalMirrorWrite {
		t.Fatalf("storage compatibility flags = %#v", config)
	}
}

func TestLoadWorkspaceNtfyWorkerDefaultsEnabled(t *testing.T) {
	config, err := LoadWorkspaceFrom(configLookup(nil))
	if err != nil {
		t.Fatal(err)
	}
	if !config.NtfyWorkerEnabled {
		t.Fatal("ntfy worker must remain enabled by default for Node compatibility")
	}
	if !config.EmailWorkerEnabled {
		t.Fatal("email worker must remain enabled by default for Node compatibility")
	}
}

func TestLoadWorkspaceBoundsOAuthTimeoutAndRejectsInvalidPort(t *testing.T) {
	config, err := LoadWorkspaceFrom(configLookup(map[string]string{GitHubOAuthTimeoutEnvironment: "4294967296"}))
	if err != nil {
		t.Fatal(err)
	}
	if config.GitHubOAuthTimeout != MaximumGitHubOAuthTimeout {
		t.Fatalf("OAuth timeout = %s", config.GitHubOAuthTimeout)
	}
	config, err = LoadWorkspaceFrom(configLookup(map[string]string{GitHubOAuthTimeoutEnvironment: "invalid"}))
	if err != nil || config.GitHubOAuthTimeout != DefaultGitHubOAuthTimeout {
		t.Fatalf("invalid timeout fallback = %s, %v", config.GitHubOAuthTimeout, err)
	}
	if _, err := LoadWorkspaceFrom(configLookup(map[string]string{"PORT": "0"})); err == nil {
		t.Fatal("invalid Workspace port was accepted")
	}
	if _, err := LoadWorkspaceFrom(configLookup(map[string]string{WorkspaceStorageDriverEnv: "ftp"})); err == nil {
		t.Fatal("invalid storage driver was accepted")
	}
	if _, err := LoadWorkspaceFrom(configLookup(map[string]string{WorkspaceEnabledEnvironment: "true", WorkspaceStorageDriverEnv: "s3"})); err == nil {
		t.Fatal("incomplete enabled S3 configuration was accepted")
	}
	if config.DataDir != DefaultWorkspaceDataDir {
		t.Fatalf("default data dir = %q", config.DataDir)
	}
	if config.EmoteCatalogPath != DefaultWorkspaceEmoteCatalog {
		t.Fatalf("default emote catalog path = %q", config.EmoteCatalogPath)
	}
}

func TestWorkspaceCatalogValidationOnlyRequiresEnabledLane(t *testing.T) {
	for _, enabled := range []string{"true", "false"} {
		configuration, err := LoadWorkspaceFrom(configLookup(map[string]string{
			WorkspaceEnabledEnvironment: enabled, WorkspaceEmoteCatalogEnv: "   ",
		}))
		if err != nil || configuration.EmoteCatalogPath != DefaultWorkspaceEmoteCatalog {
			t.Fatalf("blank environment must select catalog default, err=%v", err)
		}
		configuration.EmoteCatalogPath = ""
		err = configuration.Validate()
		if (err != nil) != (enabled == "true") {
			t.Fatalf("enabled=%s, empty catalog error=%v", enabled, err)
		}
	}
}

func configLookup(values map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}
