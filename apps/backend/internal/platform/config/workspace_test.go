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
	if config.DataDir != DefaultWorkspaceDataDir {
		t.Fatalf("default data dir = %q", config.DataDir)
	}
}

func configLookup(values map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}
