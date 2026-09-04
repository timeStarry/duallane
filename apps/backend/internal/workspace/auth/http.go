package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
)

const (
	OAuthCookieTTL        = 10 * time.Minute
	ProductionEnvironment = "production"
)

// HTTPHandler owns only the authentication transport boundary. Workspace
// domain handlers should resolve the actor with Service.ResolveActor and keep
// their own authorization checks.
type HTTPHandler struct {
	Service       *Service
	GitHub        *GitHubOAuth
	Environment   string
	PublicBaseURL string
	FrontendURL   string
	TrustProxy    bool
	// WorkspaceEnabled is the handler-level defense for routes that must not
	// touch OAuth or Workspace dependencies while the lane is disabled. Logout
	// remains reachable in that state so the browser cookie can be cleared.
	WorkspaceEnabled func() bool
	Now              Clock
}

func NewHTTPHandler(options HTTPHandler) *HTTPHandler {
	if options.Now == nil {
		options.Now = time.Now
	}
	return &options
}

func (h *HTTPHandler) IsProduction() bool {
	return h != nil && h.Environment == ProductionEnvironment
}

func (h *HTTPHandler) HandleGitHubStart(w http.ResponseWriter, r *http.Request) {
	if h == nil {
		writeError(w, wrapInternal("github handler", errors.New("handler is nil")))
		return
	}
	if !h.workspaceEnabled() {
		gate.WriteDisabled(w)
		return
	}
	secure := RequestIsSecure(r, h.TrustProxy)
	state, err := NewSessionToken()
	if err != nil {
		writeError(w, wrapInternal("generate oauth state", err))
		return
	}
	setCookie(w, OAuthCookie(OAuthStateCookieName, state, secure, time.Time{}))

	query := r.URL.Query()
	pendingInvite := NormalizeInviteCode(query.Get("invite"))
	if pendingInvite != "" {
		setCookie(w, OAuthCookie(PendingInviteCookieName, pendingInvite, secure, time.Time{}))
	}
	returnTo := NormalizeReturnTarget(query.Get("returnTo"))
	if returnTo != "" {
		setCookie(w, OAuthCookie(OAuthReturnCookieName, returnTo, secure, time.Time{}))
	} else {
		setCookie(w, ClearOAuthCookie(OAuthReturnCookieName, secure))
	}

	if h.GitHub == nil || !h.GitHub.Configured() {
		if h.IsProduction() {
			writeError(w, githubNotConfiguredError())
			return
		}
		redirectURI, err := h.callbackURL(r)
		if err != nil {
			writeError(w, err)
			return
		}
		// RedirectURI is absolute here; use it as a parsed URL so only the
		// fixed callback endpoint receives the development profile.
		fallback, err := url.Parse(redirectURI)
		if err != nil {
			writeError(w, wrapInternal("build oauth fallback", err))
			return
		}
		values := fallback.Query()
		values.Set("githubLogin", SeededOwnerGitHubLogin)
		values.Set("email", SeededOwnerEmail)
		values.Set("displayName", SeededOwnerGitHubLogin)
		fallback.RawQuery = values.Encode()
		http.Redirect(w, r, fallback.String(), http.StatusFound)
		return
	}

	redirectURI, err := h.callbackURL(r)
	if err != nil {
		writeError(w, err)
		return
	}
	authURL, err := h.GitHub.AuthorizationURL(state, redirectURI)
	if err != nil {
		writeError(w, err)
		return
	}
	http.Redirect(w, r, authURL, http.StatusFound)
}

func (h *HTTPHandler) HandleGitHubCallback(w http.ResponseWriter, r *http.Request) {
	if h == nil {
		writeError(w, wrapInternal("github handler", errors.New("handler is nil")))
		return
	}
	if !h.workspaceEnabled() {
		gate.WriteDisabled(w)
		return
	}
	secure := RequestIsSecure(r, h.TrustProxy)
	stateCookie, stateErr := r.Cookie(OAuthStateCookieName)
	returnCookie, _ := r.Cookie(OAuthReturnCookieName)
	pendingCookie, _ := r.Cookie(PendingInviteCookieName)
	returnTo := NormalizeReturnTarget(cookieValue(returnCookie))
	pendingInvite := NormalizeInviteCode(cookieValue(pendingCookie))
	// State and return target are one-time context. Clear them before any
	// external or database call, including a rejected callback.
	setCookie(w, ClearOAuthCookie(OAuthStateCookieName, secure))
	setCookie(w, ClearOAuthCookie(OAuthReturnCookieName, secure))

	query := r.URL.Query()
	code := strings.TrimSpace(query.Get("code"))
	devProfile, usingDevProfile := developmentProfile(query, h.IsProduction())
	if code != "" || !usingDevProfile {
		if stateErr != nil || !EqualSecret(strings.TrimSpace(query.Get("state")), cookieValue(stateCookie)) {
			writeError(w, invalidStateError())
			return
		}
	}

	var profile GitHubProfile
	var err error
	if usingDevProfile {
		profile = devProfile
	} else {
		redirectURI, callbackErr := h.callbackURL(r)
		if callbackErr != nil {
			writeError(w, callbackErr)
			return
		}
		if h.GitHub == nil {
			writeError(w, githubNotConfiguredError())
			return
		}
		profile, err = h.GitHub.Profile(r.Context(), code, redirectURI)
		if err != nil {
			if providerErr := h.recordProviderRejection(r.Context(), err, RequestMetaFromRequest(r, h.TrustProxy)); providerErr != nil {
				writeError(w, providerErr)
				return
			}
			writeError(w, err)
			return
		}
	}

	if h.Service == nil {
		writeError(w, wrapInternal("authenticate github", errors.New("auth service is not configured")))
		return
	}
	actor, err := h.Service.AuthenticateGitHub(r.Context(), profile, pendingInvite, RequestMetaFromRequest(r, h.TrustProxy))
	if err != nil {
		if isInviteCodeError(err) {
			setCookie(w, ClearOAuthCookie(PendingInviteCookieName, secure))
		}
		writeError(w, err)
		return
	}
	session, err := h.Service.CreateSession(r.Context(), actor.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	setCookie(w, SessionCookie(session, secure))
	setCookie(w, ClearOAuthCookie(PendingInviteCookieName, secure))

	if wantsJSON(r) || query.Get("format") == "json" {
		writeJSON(w, http.StatusOK, map[string]any{
			"user": PublicActor(actor),
			"session": map[string]any{
				"expiresAt": externalTime(session.ExpiresAt),
			},
		})
		return
	}
	location, locationErr := h.frontendURL(returnTo)
	if locationErr != nil {
		writeError(w, locationErr)
		return
	}
	http.Redirect(w, r, location, http.StatusFound)
}

func (h *HTTPHandler) recordProviderRejection(ctx context.Context, err error, meta RequestMeta) error {
	if h == nil || h.Service == nil {
		return nil
	}
	var authErr *Error
	if !errors.As(err, &authErr) || authErr.Code != CodeGitHubFailed {
		return nil
	}
	if recordErr := h.Service.RecordGitHubLoginRejection(ctx, authErr.Phase, meta); recordErr != nil {
		return wrapInternal("record github rejection", recordErr)
	}
	return nil
}

func (h *HTTPHandler) HandleLogout(w http.ResponseWriter, r *http.Request) {
	secure := RequestIsSecure(r, h != nil && h.TrustProxy)
	if h != nil && h.workspaceEnabled() && h.Service != nil {
		if cookie, err := r.Cookie(SessionCookieName); err == nil {
			if _, revokeErr := h.Service.RevokeSession(r.Context(), cookie.Value); revokeErr != nil {
				writeError(w, revokeErr)
				return
			}
		}
	}
	setCookie(w, ClearSessionCookie(secure))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *HTTPHandler) ResolveActor(ctx context.Context, r *http.Request) (*Actor, error) {
	if h == nil || h.Service == nil {
		return nil, requiredError()
	}
	if !h.IsProduction() {
		if userID := strings.TrimSpace(r.Header.Get("X-Workspace-User-ID")); userID != "" {
			return h.Service.ResolveActorID(ctx, userID)
		}
	}
	return h.Service.ResolveActorFromRequest(ctx, r)
}

func (h *HTTPHandler) callbackURL(r *http.Request) (string, error) {
	origin, err := h.publicOrigin(r)
	if err != nil {
		return "", err
	}
	return origin + "/api/auth/github/callback", nil
}

func (h *HTTPHandler) publicOrigin(r *http.Request) (string, error) {
	configured := strings.TrimSpace(h.PublicBaseURL)
	if configured == "" && h.IsProduction() {
		return "", githubNotConfiguredError()
	}
	if configured == "" {
		if r == nil || strings.TrimSpace(r.Host) == "" {
			return "", githubNotConfiguredError()
		}
		scheme := "http"
		if RequestIsSecure(r, h.TrustProxy) {
			scheme = "https"
		}
		configured = scheme + "://" + r.Host
	}
	parsed, err := url.Parse(configured)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || strings.TrimRight(parsed.Path, "/") != "" {
		return "", githubNotConfiguredError()
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && !h.IsProduction() && isLoopbackHost(parsed.Hostname())) {
		return "", githubNotConfiguredError()
	}
	parsed.Path = ""
	return strings.TrimRight(parsed.String(), "/"), nil
}

func (h *HTTPHandler) frontendURL(returnTo string) (string, error) {
	if returnTo == "" {
		returnTo = "/workspace"
	}
	base := strings.TrimSpace(h.FrontendURL)
	if base == "" {
		if h.IsProduction() {
			return returnTo, nil
		}
		base = "http://127.0.0.1:5173"
	}
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", githubNotConfiguredError()
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && !h.IsProduction() && isLoopbackHost(parsed.Hostname())) {
		return "", githubNotConfiguredError()
	}
	target, err := url.Parse(returnTo)
	if err != nil || target.IsAbs() || target.Host != "" || (target.Path != "/workspace" && !strings.HasPrefix(target.Path, "/workspace/")) {
		return "", invalidStateError()
	}
	// A leading slash is intentionally rooted at the configured frontend
	// origin, matching the current browser return behavior even when the
	// frontend is served under a deployment-specific path.
	parsed.Path = target.Path
	parsed.RawQuery = target.RawQuery
	return parsed.String(), nil
}

func (h *HTTPHandler) workspaceEnabled() bool {
	if h == nil || h.WorkspaceEnabled == nil {
		// Preserve the handler's historical enabled behavior for callers that
		// construct it directly. The command wiring supplies the real gate.
		return true
	}
	return h.WorkspaceEnabled()
}

func RequestIsSecure(r *http.Request, trustProxy bool) bool {
	if r == nil {
		return false
	}
	if r.TLS != nil {
		return true
	}
	if !trustProxy {
		return false
	}
	forwarded := r.Header.Get("X-Forwarded-Proto")
	if comma := strings.IndexByte(forwarded, ','); comma >= 0 {
		forwarded = forwarded[:comma]
	}
	return strings.EqualFold(strings.TrimSpace(forwarded), "https")
}

func developmentProfile(query url.Values, production bool) (GitHubProfile, bool) {
	if production {
		return GitHubProfile{}, false
	}
	if query.Get("githubLogin") == "" && query.Get("githubId") == "" && query.Get("email") == "" {
		return GitHubProfile{}, false
	}
	profile, err := NormalizeGitHubProfile(GitHubProfile{
		ID:        query.Get("githubId"),
		Login:     query.Get("githubLogin"),
		Email:     query.Get("email"),
		Name:      query.Get("displayName"),
		AvatarURL: query.Get("avatarUrl"),
	})
	if err != nil {
		return GitHubProfile{}, true
	}
	return profile, true
}

func cookieValue(cookie *http.Cookie) string {
	if cookie == nil {
		return ""
	}
	return cookie.Value
}

func wantsJSON(r *http.Request) bool {
	return r != nil && strings.Contains(strings.ToLower(r.Header.Get("Accept")), "application/json")
}

func isInviteCodeError(err error) bool {
	var authErr *Error
	if !errors.As(err, &authErr) {
		return false
	}
	return authErr.Code == CodeInviteInvalid || authErr.Code == CodeInviteExpired || authErr.Code == CodeInviteExhausted
}

func writeError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	public := &Error{Code: "internal.error", Message: "服务暂时不可用", StatusCode: status}
	var authErr *Error
	if errors.As(err, &authErr) && authErr != nil {
		status = authErr.StatusCode
		public = authErr.Public()
	}
	writeJSON(w, status, map[string]any{"error": public})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func setCookie(w http.ResponseWriter, cookie http.Cookie) {
	http.SetCookie(w, &cookie)
}

func isLoopbackHost(host string) bool {
	return host == "127.0.0.1" || host == "localhost" || host == "::1"
}
