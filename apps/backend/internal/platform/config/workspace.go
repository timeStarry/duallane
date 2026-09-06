package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	DefaultWorkspaceEnvironment    = "development"
	DefaultGitHubOAuthTimeout      = 8 * time.Second
	MaximumGitHubOAuthTimeout      = 30 * time.Second
	WorkspaceEnabledEnvironment    = "WORKSPACE_ENABLED"
	WorkspaceFrontendEnvironment   = "WORKSPACE_FRONTEND_URL"
	GitHubOAuthTimeoutEnvironment  = "GITHUB_OAUTH_TIMEOUT_MS"
	WorkspaceDataDirEnvironment    = "DUALLANE_DATA_DIR"
	WorkspaceEmoteCatalogEnv       = "DUALLANE_EMOTE_CATALOG_PATH"
	WorkspaceReleaseCatalogEnv     = "DUALLANE_ECHO_RELEASE_CATALOG_PATH"
	WorkspaceMigrationsDirEnv      = "DUALLANE_MIGRATIONS_DIR"
	WorkspaceNtfyBaseEnvironment   = "WORKSPACE_NTFY_BASE_URL"
	WorkspaceNtfyWorkerEnabled     = "WORKSPACE_NTFY_WORKER_ENABLED"
	WorkspaceEmailWorkerEnabled    = "WORKSPACE_EMAIL_WORKER_ENABLED"
	WorkspaceMaintenanceWorkerEnv  = "WORKSPACE_MAINTENANCE_WORKER_ENABLED"
	WorkspaceSMTPEncryptionKey     = "WORKSPACE_SMTP_ENCRYPTION_KEY"
	WorkspaceStorageDriverEnv      = "WORKSPACE_STORAGE_DRIVER"
	WorkspaceS3EndpointEnv         = "WORKSPACE_S3_ENDPOINT"
	WorkspaceS3BucketEnv           = "WORKSPACE_S3_BUCKET"
	WorkspaceS3RegionEnv           = "WORKSPACE_S3_REGION"
	WorkspaceS3CredentialsFileEnv  = "WORKSPACE_S3_CREDENTIALS_FILE"
	WorkspaceLocalReadFallbackEnv  = "WORKSPACE_STORAGE_LOCAL_READ_FALLBACK"
	WorkspaceLocalMirrorWriteEnv   = "WORKSPACE_STORAGE_LOCAL_MIRROR_WRITE"
	DefaultWorkspaceDataDir        = "../../data"
	DefaultWorkspaceEmoteCatalog   = "../web/shared/emote-packs.json"
	DefaultWorkspaceReleaseCatalog = "../web/shared/echo-release-guides.json"
	DefaultWorkspaceMigrationsDir  = "../web/server/migrations"
)

// WorkspaceConfig contains request-serving configuration for the retained,
// audited lane. Secrets are kept only as values for dependency construction;
// this type deliberately has no String or logging projection.
type WorkspaceConfig struct {
	Host               string
	Port               int
	AppVersion         string
	Commit             string
	Environment        string
	Enabled            bool
	PublicBaseURL      string
	FrontendURL        string
	TrustProxy         bool
	GitHubClientID     string
	GitHubClientSecret string
	GitHubProxyURL     string
	GitHubOAuthTimeout time.Duration
	DataDir            string
	EmoteCatalogPath   string
	ReleaseCatalogPath string
	MigrationsDir      string
	NtfyBaseURL        string
	NtfyWorkerEnabled  bool
	EmailWorkerEnabled bool
	MaintenanceEnabled bool
	SMTPEncryptionKey  string
	StorageDriver      string
	S3Endpoint         string
	S3Bucket           string
	S3Region           string
	S3CredentialsFile  string
	LocalReadFallback  bool
	LocalMirrorWrite   bool
}

func LoadWorkspace() (WorkspaceConfig, error) {
	return LoadWorkspaceFrom(os.LookupEnv)
}

func LoadWorkspaceFrom(lookup func(string) (string, bool)) (WorkspaceConfig, error) {
	if lookup == nil {
		return WorkspaceConfig{}, errors.New("configuration lookup is required")
	}
	appVersion := valueOr(lookup, "DUALLANE_APP_VERSION", "")
	if appVersion == "" {
		appVersion = valueOr(lookup, "APP_VERSION", DefaultAppVersion)
	}
	workspaceEnabledValue, _ := lookup(WorkspaceEnabledEnvironment)
	maintenanceEnabledValue, _ := lookup(WorkspaceMaintenanceWorkerEnv)
	config := WorkspaceConfig{
		Host:               valueOr(lookup, "HOST", DefaultHost),
		Port:               DefaultPort,
		AppVersion:         appVersion,
		Commit:             valueOr(lookup, "DUALLANE_GIT_COMMIT", "unknown"),
		Environment:        valueOr(lookup, "NODE_ENV", DefaultWorkspaceEnvironment),
		Enabled:            workspaceEnabledValue == "true",
		PublicBaseURL:      strings.TrimSpace(valueOr(lookup, "PUBLIC_BASE_URL", "")),
		FrontendURL:        strings.TrimSpace(valueOr(lookup, WorkspaceFrontendEnvironment, "")),
		TrustProxy:         valueOr(lookup, "TRUST_PROXY", "false") == "true",
		GitHubClientID:     strings.TrimSpace(valueOr(lookup, "GITHUB_CLIENT_ID", "")),
		GitHubClientSecret: strings.TrimSpace(valueOr(lookup, "GITHUB_CLIENT_SECRET", "")),
		GitHubProxyURL:     strings.TrimSpace(valueOr(lookup, "GITHUB_PROXY_URL", "")),
		GitHubOAuthTimeout: DefaultGitHubOAuthTimeout,
		DataDir:            strings.TrimSpace(valueOr(lookup, WorkspaceDataDirEnvironment, DefaultWorkspaceDataDir)),
		EmoteCatalogPath:   strings.TrimSpace(valueOr(lookup, WorkspaceEmoteCatalogEnv, DefaultWorkspaceEmoteCatalog)),
		ReleaseCatalogPath: strings.TrimSpace(valueOr(lookup, WorkspaceReleaseCatalogEnv, DefaultWorkspaceReleaseCatalog)),
		MigrationsDir:      strings.TrimSpace(valueOr(lookup, WorkspaceMigrationsDirEnv, DefaultWorkspaceMigrationsDir)),
		NtfyBaseURL:        strings.TrimSpace(valueOr(lookup, WorkspaceNtfyBaseEnvironment, "")),
		NtfyWorkerEnabled:  valueOr(lookup, WorkspaceNtfyWorkerEnabled, "true") != "false",
		EmailWorkerEnabled: valueOr(lookup, WorkspaceEmailWorkerEnabled, "true") != "false",
		MaintenanceEnabled: maintenanceEnabledValue == "true",
		SMTPEncryptionKey:  strings.TrimSpace(valueOr(lookup, WorkspaceSMTPEncryptionKey, "")),
		StorageDriver:      strings.ToLower(valueOr(lookup, WorkspaceStorageDriverEnv, "local")),
		S3Endpoint:         strings.TrimSpace(valueOr(lookup, WorkspaceS3EndpointEnv, "")),
		S3Bucket:           strings.TrimSpace(valueOr(lookup, WorkspaceS3BucketEnv, "")),
		S3Region:           strings.TrimSpace(valueOr(lookup, WorkspaceS3RegionEnv, "us-east-1")),
		S3CredentialsFile:  strings.TrimSpace(valueOr(lookup, WorkspaceS3CredentialsFileEnv, "")),
		LocalReadFallback:  valueOr(lookup, WorkspaceLocalReadFallbackEnv, "false") == "true",
		LocalMirrorWrite:   valueOr(lookup, WorkspaceLocalMirrorWriteEnv, "false") == "true",
	}
	if raw, ok := lookup("PORT"); ok && strings.TrimSpace(raw) != "" {
		port, err := strconv.Atoi(strings.TrimSpace(raw))
		if err != nil || port < 1 || port > 65535 {
			return WorkspaceConfig{}, errors.New("PORT must be between 1 and 65535")
		}
		config.Port = port
	}
	if raw, ok := lookup(GitHubOAuthTimeoutEnvironment); ok && strings.TrimSpace(raw) != "" {
		milliseconds, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
		if err == nil && milliseconds > 0 {
			if milliseconds >= int64(MaximumGitHubOAuthTimeout/time.Millisecond) {
				config.GitHubOAuthTimeout = MaximumGitHubOAuthTimeout
			} else {
				config.GitHubOAuthTimeout = time.Duration(milliseconds) * time.Millisecond
			}
		}
	}
	if err := config.Validate(); err != nil {
		return WorkspaceConfig{}, err
	}
	return config, nil
}

func (config WorkspaceConfig) Validate() error {
	if strings.TrimSpace(config.Host) == "" {
		return errors.New("HOST must not be empty")
	}
	if config.Port < 1 || config.Port > 65535 {
		return errors.New("PORT must be between 1 and 65535")
	}
	if strings.TrimSpace(config.AppVersion) == "" {
		return errors.New("APP_VERSION must not be empty")
	}
	if config.GitHubOAuthTimeout <= 0 || config.GitHubOAuthTimeout > MaximumGitHubOAuthTimeout {
		return fmt.Errorf("GitHub OAuth timeout must be between 1ms and %s", MaximumGitHubOAuthTimeout)
	}
	if config.Enabled && strings.TrimSpace(config.DataDir) == "" {
		return errors.New("DUALLANE_DATA_DIR must not be empty when Workspace is enabled")
	}
	if config.Enabled && strings.TrimSpace(config.EmoteCatalogPath) == "" {
		return errors.New("DUALLANE_EMOTE_CATALOG_PATH must not be empty when Workspace is enabled")
	}
	if config.Enabled && strings.TrimSpace(config.ReleaseCatalogPath) == "" {
		return errors.New("DUALLANE_ECHO_RELEASE_CATALOG_PATH must not be empty when Workspace is enabled")
	}
	if config.Enabled && strings.TrimSpace(config.MigrationsDir) == "" {
		return errors.New("DUALLANE_MIGRATIONS_DIR must not be empty when Workspace is enabled")
	}
	if config.StorageDriver != "local" && config.StorageDriver != "s3" {
		return errors.New("WORKSPACE_STORAGE_DRIVER must be local or s3")
	}
	if config.Enabled && config.StorageDriver == "s3" {
		if config.S3Endpoint == "" || config.S3Bucket == "" || config.S3CredentialsFile == "" {
			return errors.New("S3 endpoint, bucket, and credentials file are required when S3 storage is enabled")
		}
	}
	return nil
}

func (config WorkspaceConfig) ListenAddress() string {
	return fmt.Sprintf("%s:%d", config.Host, config.Port)
}
