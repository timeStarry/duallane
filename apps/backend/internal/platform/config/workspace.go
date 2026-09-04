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
	DefaultWorkspaceEnvironment   = "development"
	DefaultGitHubOAuthTimeout     = 8 * time.Second
	MaximumGitHubOAuthTimeout     = 30 * time.Second
	WorkspaceEnabledEnvironment   = "WORKSPACE_ENABLED"
	WorkspaceFrontendEnvironment  = "WORKSPACE_FRONTEND_URL"
	GitHubOAuthTimeoutEnvironment = "GITHUB_OAUTH_TIMEOUT_MS"
	WorkspaceDataDirEnvironment   = "DUALLANE_DATA_DIR"
	DefaultWorkspaceDataDir       = "../../data"
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
	return nil
}

func (config WorkspaceConfig) ListenAddress() string {
	return fmt.Sprintf("%s:%d", config.Host, config.Port)
}
