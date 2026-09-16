package auth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const MobileRedirectURI = "com.timestarry.duallane://oauth"
const mobileFlowCookie = "duallane_mobile_flow"

var pkceVerifierPattern = regexp.MustCompile(`^[A-Za-z0-9._~-]{43,128}$`)
var challengePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

type MobileFlow struct {
	ID, Challenge, RedirectURI, ClientState, UserID string
	ExpiresAt                                       time.Time
}
type MobileTokens struct {
	AccessToken           string `json:"accessToken"`
	RefreshToken          string `json:"refreshToken"`
	AccessTokenExpiresAt  string `json:"accessTokenExpiresAt"`
	RefreshTokenExpiresAt string `json:"refreshTokenExpiresAt"`
}
type MobileRepository interface {
	Allow(context.Context, string, time.Time) (bool, error)
	SaveFlow(context.Context, MobileFlow) error
	GetFlow(context.Context, string, time.Time) (MobileFlow, error)
	AuthorizeFlow(context.Context, string, string, string, time.Time) (MobileFlow, error)
	Exchange(context.Context, string, string, string, MobileTokens, time.Time) error
	Rotate(context.Context, string, *MobileTokens, time.Time) error
	Revoke(context.Context, string, time.Time) error
	Resolve(context.Context, string, time.Time) (*Actor, error)
}
type MobileService struct {
	Repository MobileRepository
	Now        Clock
}

func (s *MobileService) now() time.Time { return normalizedNow(s.Now) }
func (s *MobileService) tokens() (MobileTokens, error) {
	access, err := NewSessionToken()
	if err != nil {
		return MobileTokens{}, err
	}
	refresh, err := NewSessionToken()
	if err != nil {
		return MobileTokens{}, err
	}
	now := s.now()
	return MobileTokens{access, refresh, externalTime(now.Add(15 * time.Minute)), externalTime(now.Add(30 * 24 * time.Hour))}, nil
}
func mobileInvalid() error {
	return NewError("auth.mobile_invalid", "登录已失效，请重试", http.StatusUnauthorized)
}
func verifyPKCE(verifier, challenge string) bool {
	if !pkceVerifierPattern.MatchString(verifier) {
		return false
	}
	digest := sha256.Sum256([]byte(verifier))
	return EqualSecret(base64.RawURLEncoding.EncodeToString(digest[:]), challenge)
}
func (h *HTTPHandler) mobileReady(w http.ResponseWriter, r *http.Request) bool {
	w.Header().Set("Cache-Control", "no-store")
	if !h.workspaceEnabled() {
		writeError(w, NewError("workspace.disabled", "共享空间暂未开放", 503))
		return false
	}
	if h.Mobile == nil || h.Mobile.Repository == nil {
		writeError(w, NewError("mobile.not_configured", "服务器尚未开放 Android 登录", 503))
		return false
	}
	// Durable, content-free abuse buckets; no raw addresses or tokens are persisted.
	meta := RequestMetaFromRequest(r, h.TrustProxy)
	allowed, err := h.Mobile.Repository.Allow(r.Context(), HashSecret(meta.IPAddress), h.Mobile.now())
	if err != nil {
		writeError(w, wrapInternal("mobile rate", err))
		return false
	}
	if !allowed {
		writeError(w, NewError("limit.exceeded", "请求过于频繁，请稍后重试", 429))
		return false
	}
	return true
}
func (h *HTTPHandler) HandleMobileStart(w http.ResponseWriter, r *http.Request) {
	if !h.mobileReady(w, r) {
		return
	}
	var body struct {
		CodeChallenge string `json:"codeChallenge"`
		RedirectURI   string `json:"redirectUri"`
		State         string `json:"state"`
		InviteCode    string `json:"inviteCode"`
	}
	if err := decodeAuthJSON(w, r, &body); err != nil {
		writeError(w, err)
		return
	}
	if body.RedirectURI != MobileRedirectURI || !challengePattern.MatchString(body.CodeChallenge) || len(body.State) < 16 || len(body.State) > 128 || containsControl(body.State) {
		writeError(w, mobileInvalid())
		return
	}
	flowID, err := NewSessionToken()
	if err != nil {
		writeError(w, wrapInternal("mobile id", err))
		return
	}
	flow := MobileFlow{ID: flowID, Challenge: body.CodeChallenge, RedirectURI: body.RedirectURI, ClientState: body.State, ExpiresAt: h.Mobile.now().Add(10 * time.Minute)}
	if err = h.Mobile.Repository.SaveFlow(r.Context(), flow); err != nil {
		writeError(w, wrapInternal("mobile flow", err))
		return
	}
	origin, err := h.publicOrigin(r)
	if err != nil {
		writeError(w, err)
		return
	}
	q := url.Values{"flow": {flowID}}
	if invite := NormalizeInviteCode(body.InviteCode); invite != "" {
		q.Set("invite", invite)
	}
	writeJSON(w, 200, map[string]string{"authorizationUrl": origin + "/api/auth/mobile/github/authorize?" + q.Encode()})
}
func (h *HTTPHandler) HandleMobileAuthorize(w http.ResponseWriter, r *http.Request) {
	if !h.mobileReady(w, r) {
		return
	}
	flowID := r.URL.Query().Get("flow")
	if _, err := h.Mobile.Repository.GetFlow(r.Context(), flowID, h.Mobile.now()); err != nil {
		writeError(w, mobileInvalid())
		return
	}
	cookie := OAuthCookie(mobileFlowCookie, flowID, RequestIsSecure(r, h.TrustProxy), time.Time{})
	cookie.MaxAge = 600
	setCookie(w, cookie)
	// The existing provider flow owns its state cookie and invite checks.
	h.HandleGitHubStart(w, r)
}
func (h *HTTPHandler) completeMobile(w http.ResponseWriter, r *http.Request, actor *Actor) bool {
	cookie, err := r.Cookie(mobileFlowCookie)
	if err != nil {
		return false
	}
	setCookie(w, ClearOAuthCookie(mobileFlowCookie, RequestIsSecure(r, h.TrustProxy)))
	if h.Mobile == nil {
		writeError(w, mobileInvalid())
		return true
	}
	code, err := NewSessionToken()
	if err != nil {
		writeError(w, wrapInternal("mobile code", err))
		return true
	}
	flow, err := h.Mobile.Repository.AuthorizeFlow(r.Context(), cookie.Value, actor.ID, HashSecret(code), h.Mobile.now())
	if err != nil {
		writeError(w, mobileInvalid())
		return true
	}
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, MobileRedirectURI+"?"+url.Values{"code": {code}, "state": {flow.ClientState}}.Encode(), http.StatusFound)
	return true
}
func (h *HTTPHandler) HandleMobileExchange(w http.ResponseWriter, r *http.Request) {
	if !h.mobileReady(w, r) {
		return
	}
	var body struct {
		Code         string `json:"code"`
		CodeVerifier string `json:"codeVerifier"`
		RedirectURI  string `json:"redirectUri"`
	}
	if err := decodeAuthJSON(w, r, &body); err != nil {
		writeError(w, err)
		return
	}
	if body.RedirectURI != MobileRedirectURI || len(body.Code) > 128 || !pkceVerifierPattern.MatchString(body.CodeVerifier) {
		writeError(w, mobileInvalid())
		return
	}
	tokens, err := h.Mobile.tokens()
	if err == nil {
		err = h.Mobile.Repository.Exchange(r.Context(), HashSecret(body.Code), body.CodeVerifier, body.RedirectURI, tokens, h.Mobile.now())
	}
	if err != nil {
		_ = h.Service.RecordGitHubLoginRejection(r.Context(), "exchange", RequestMetaFromRequest(r, h.TrustProxy))
		writeError(w, mobileInvalid())
		return
	}
	writeJSON(w, 200, tokens)
}
func (h *HTTPHandler) HandleMobileRefresh(w http.ResponseWriter, r *http.Request) {
	if !h.mobileReady(w, r) {
		return
	}
	var body struct {
		RefreshToken string `json:"refreshToken"`
	}
	if err := decodeAuthJSON(w, r, &body); err != nil {
		writeError(w, err)
		return
	}
	if len(body.RefreshToken) < 16 || len(body.RefreshToken) > 128 {
		writeError(w, mobileInvalid())
		return
	}
	tokens, err := h.Mobile.tokens()
	if err == nil {
		err = h.Mobile.Repository.Rotate(r.Context(), HashSecret(body.RefreshToken), &tokens, h.Mobile.now())
	}
	if err != nil {
		_ = h.Service.RecordGitHubLoginRejection(r.Context(), "exchange", RequestMetaFromRequest(r, h.TrustProxy))
		writeError(w, mobileInvalid())
		return
	}
	writeJSON(w, 200, tokens)
}
func (h *HTTPHandler) HandleMobileLogout(w http.ResponseWriter, r *http.Request) {
	if !h.mobileReady(w, r) {
		return
	}
	var body struct {
		RefreshToken string `json:"refreshToken"`
	}
	if err := decodeAuthJSON(w, r, &body); err != nil {
		writeError(w, err)
		return
	}
	if len(body.RefreshToken) > 128 {
		writeError(w, mobileInvalid())
		return
	}
	if err := h.Mobile.Repository.Revoke(r.Context(), HashSecret(body.RefreshToken), h.Mobile.now()); err != nil {
		writeError(w, wrapInternal("mobile logout", err))
		return
	}
	w.WriteHeader(204)
}
func (h *HTTPHandler) resolveMobile(ctx context.Context, r *http.Request) (*Actor, error) {
	if h.Mobile == nil || h.Mobile.Repository == nil || !h.workspaceEnabled() {
		return nil, requiredError()
	}
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") || len(header) > 150 {
		return nil, requiredError()
	}
	token := strings.TrimPrefix(header, "Bearer ")
	actor, err := h.Mobile.Repository.Resolve(ctx, HashSecret(token), h.Mobile.now())
	if err != nil {
		return nil, err
	}
	if actor == nil {
		return nil, requiredError()
	}
	return actor, nil
}

var errMobileInvalid = errors.New("invalid mobile session")
