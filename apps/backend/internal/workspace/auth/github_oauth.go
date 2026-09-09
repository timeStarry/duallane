package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/github"
)

const (
	DefaultGitHubOAuthTimeout = 8 * time.Second
	MaxGitHubOAuthTimeout     = 30 * time.Second
	GitHubUserAgent           = "DualLane/0.1"
	GitHubUserEndpoint        = "https://api.github.com/user"
	GitHubEmailsEndpoint      = "https://api.github.com/user/emails"
	MaxGitHubResponseBytes    = 1 << 20
)

type GitHubOAuthConfig struct {
	ClientID     string
	ClientSecret string
	Timeout      time.Duration
	ProxyURL     string
	HTTPClient   *http.Client
}

type GitHubOAuth struct {
	config  oauth2.Config
	client  *http.Client
	timeout time.Duration
}

func NewGitHubOAuth(options GitHubOAuthConfig) (*GitHubOAuth, error) {
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = DefaultGitHubOAuthTimeout
	}
	if timeout > MaxGitHubOAuthTimeout {
		timeout = MaxGitHubOAuthTimeout
	}

	client := options.HTTPClient
	if client == nil {
		transport, err := newGitHubTransport(options.ProxyURL)
		if err != nil {
			return nil, err
		}
		client = &http.Client{Transport: transport, Timeout: timeout}
	}
	return &GitHubOAuth{
		config: oauth2.Config{
			ClientID:     strings.TrimSpace(options.ClientID),
			ClientSecret: strings.TrimSpace(options.ClientSecret),
			Endpoint:     github.Endpoint,
			Scopes:       []string{"read:user", "user:email"},
		},
		client:  client,
		timeout: timeout,
	}, nil
}

func (g *GitHubOAuth) Configured() bool {
	return g != nil && g.config.ClientID != "" && g.config.ClientSecret != ""
}

func (g *GitHubOAuth) AuthorizationURL(state, redirectURI string) (string, error) {
	if g == nil || !g.Configured() {
		return "", githubNotConfiguredError()
	}
	if strings.TrimSpace(state) == "" || !validGitHubRedirectURI(redirectURI) {
		return "", invalidStateError()
	}
	config := g.config
	config.RedirectURL = redirectURI
	return config.AuthCodeURL(state), nil
}

// Profile exchanges a one-time authorization code and obtains the minimum
// GitHub identity needed by Workspace. One context deadline covers all
// provider calls so a slow email endpoint cannot extend the login budget.
func (g *GitHubOAuth) Profile(ctx context.Context, code, redirectURI string) (GitHubProfile, error) {
	if g == nil || !g.Configured() {
		return GitHubProfile{}, githubNotConfiguredError()
	}
	code = strings.TrimSpace(code)
	if code == "" || !validGitHubRedirectURI(redirectURI) {
		return GitHubProfile{}, githubFailedError()
	}
	if ctx == nil {
		ctx = context.Background()
	}
	deadlineCtx, cancel := context.WithTimeout(ctx, g.timeout)
	defer cancel()
	oauthCtx := context.WithValue(deadlineCtx, oauth2.HTTPClient, g.client)
	token, err := g.config.Exchange(oauthCtx, code)
	if err != nil || token == nil || !token.Valid() || token.AccessToken == "" {
		return GitHubProfile{}, withGitHubCause(githubFailedError(), "token", "github token exchange", err)
	}

	var userPayload struct {
		ID        json.Number `json:"id"`
		Login     string      `json:"login"`
		Name      string      `json:"name"`
		AvatarURL string      `json:"avatar_url"`
		Email     string      `json:"email"`
	}
	if err := g.getJSON(deadlineCtx, GitHubUserEndpoint, token.AccessToken, &userPayload); err != nil {
		return GitHubProfile{}, withGitHubCause(githubFailedError(), "profile", "github user lookup", err)
	}
	profile := GitHubProfile{
		ID:        userPayload.ID.String(),
		Login:     userPayload.Login,
		Name:      userPayload.Name,
		AvatarURL: userPayload.AvatarURL,
		Email:     userPayload.Email,
	}
	if profile.Email == "" {
		var emails []githubEmail
		if err := g.getJSON(deadlineCtx, GitHubEmailsEndpoint, token.AccessToken, &emails); err != nil {
			return GitHubProfile{}, withGitHubCause(githubFailedError(), "email", "github email lookup", err)
		}
		profile.Email = primaryVerifiedEmail(emails)
	}
	if profile.ID == "" || profile.Login == "" {
		return GitHubProfile{}, withGitHubCause(githubFailedError(), "profile", "github profile is incomplete", nil)
	}
	normalized, err := NormalizeGitHubProfile(profile)
	if err != nil {
		return GitHubProfile{}, withGitHubCause(githubFailedError(), "profile", "normalize github profile", err)
	}
	return normalized, nil
}

type githubEmail struct {
	Email    string `json:"email"`
	Primary  bool   `json:"primary"`
	Verified bool   `json:"verified"`
}

func primaryVerifiedEmail(emails []githubEmail) string {
	for _, item := range emails {
		if item.Primary && item.Verified {
			return strings.TrimSpace(item.Email)
		}
	}
	for _, item := range emails {
		if item.Verified {
			return strings.TrimSpace(item.Email)
		}
	}
	return ""
}

func (g *GitHubOAuth) getJSON(ctx context.Context, endpoint, accessToken string, target any) error {
	if !isApprovedGitHubURL(endpoint) {
		return errors.New("github endpoint is outside the approved host boundary")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+accessToken)
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", GitHubUserAgent)
	response, err := g.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("github response status %d", response.StatusCode)
	}
	// Read one byte beyond the accepted budget so a provider cannot hide an
	// oversized response behind a valid JSON prefix. Decode twice to reject
	// concatenated JSON values and non-whitespace trailing data.
	body, err := io.ReadAll(io.LimitReader(response.Body, MaxGitHubResponseBytes+1))
	if err != nil {
		return err
	}
	if len(body) > MaxGitHubResponseBytes {
		return errors.New("github response exceeds size limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return errors.New("github response contains trailing JSON")
		}
		return err
	}
	return nil
}

func NormalizeGitHubProxyURL(value string) (*url.URL, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "http" || parsed.Hostname() == "" || parsed.Port() == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.RawPath != "" || (parsed.Path != "" && parsed.Path != "/") {
		return nil, errors.New("GITHUB_PROXY_URL must be an unauthenticated HTTP proxy URL with an explicit port")
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port < 1 || port > 65535 {
		return nil, errors.New("GITHUB_PROXY_URL must use a valid TCP port")
	}
	parsed.Path = "/"
	return parsed, nil
}

func newGitHubTransport(proxy string) (*http.Transport, error) {
	base, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		return nil, errors.New("default HTTP transport is not configurable")
	}
	transport := base.Clone()
	transport.Proxy = nil
	if strings.TrimSpace(proxy) != "" {
		parsed, err := NormalizeGitHubProxyURL(proxy)
		if err != nil {
			return nil, err
		}
		transport.Proxy = http.ProxyURL(parsed)
	}
	return transport, nil
}

func isApprovedGitHubURL(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Port() != "" {
		return false
	}
	return parsed.Hostname() == "github.com" || parsed.Hostname() == "api.github.com"
}

func validGitHubRedirectURI(value string) bool {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	if parsed.Scheme == "https" {
		return true
	}
	if parsed.Scheme != "http" {
		return false
	}
	// Plain HTTP is only acceptable for loopback development callbacks.
	host := parsed.Hostname()
	return host == "127.0.0.1" || host == "localhost" || host == "::1"
}

func ParseGitHubOAuthTimeoutMillis(value string) time.Duration {
	parsed, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if err != nil || parsed <= 0 {
		return DefaultGitHubOAuthTimeout
	}
	if parsed > int64(MaxGitHubOAuthTimeout/time.Millisecond) {
		return MaxGitHubOAuthTimeout
	}
	return time.Duration(parsed) * time.Millisecond
}

func withGitHubCause(publicErr *Error, phase, context string, cause error) *Error {
	publicErr.Phase = normalizeOAuthFailurePhase(phase)
	if cause == nil {
		return publicErr
	}
	publicErr.Cause = fmt.Errorf("%s: %w", context, cause)
	return publicErr
}
