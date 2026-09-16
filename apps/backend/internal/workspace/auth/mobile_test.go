package auth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

type mobileTestRepository struct {
	MobileRepository
	flow       MobileFlow
	err        error
	auditErr   error
	audits     []string
	authorized bool
	allowed    bool
}

func (s *mobileTestRepository) Allow(context.Context, string, time.Time) (bool, error) {
	return s.allowed, nil
}
func (s *mobileTestRepository) GetFlow(context.Context, string, time.Time) (MobileFlow, error) {
	return s.flow, s.err
}
func (s *mobileTestRepository) AuthorizeFlow(context.Context, string, string, string, time.Time) (MobileFlow, error) {
	s.authorized = true
	return s.flow, s.err
}
func (s *mobileTestRepository) Exchange(context.Context, string, string, string, MobileTokens, time.Time) error {
	return s.err
}
func (s *mobileTestRepository) Rotate(context.Context, string, *MobileTokens, time.Time) error {
	return s.err
}
func (s *mobileTestRepository) RecordRejection(_ context.Context, operation string, _ RequestMeta, _ time.Time) error {
	s.audits = append(s.audits, operation)
	return s.auditErr
}

func mobileTestHandler() (*HTTPHandler, *mobileTestRepository) {
	store := newFakeStore()
	actor := &Actor{ID: SeededOwnerID, GitHubLogin: SeededOwnerGitHubLogin, Kind: "human", Role: "owner"}
	store.actors[actor.ID] = actor
	store.authenticate = func(GitHubProfile, string, time.Time) (*Actor, error) { return actor, nil }
	repository := &mobileTestRepository{allowed: true, flow: MobileFlow{ClientState: "client-state-to-return"}}
	return NewHTTPHandler(HTTPHandler{Service: NewService(ServiceOptions{Store: store}),
		Mobile: &MobileService{Repository: repository}, PublicBaseURL: "https://duallane.example.test"}), repository
}

func TestMobileHandlersRejectMissingService(t *testing.T) {
	handler, _ := mobileTestHandler()
	handler.Mobile = nil
	for name, handle := range map[string]http.HandlerFunc{
		"start": handler.HandleMobileStart, "authorize": handler.HandleMobileAuthorize,
		"exchange": handler.HandleMobileExchange, "refresh": handler.HandleMobileRefresh,
		"logout": handler.HandleMobileLogout,
	} {
		t.Run(name, func(t *testing.T) {
			response := httptest.NewRecorder()
			handle(response, httptest.NewRequest(http.MethodPost, "/api/auth/mobile/"+name, strings.NewReader(`{}`)))
			if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), `"mobile.not_configured"`) {
				t.Fatalf("unconfigured mobile handler: status=%d", response.Code)
			}
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("unconfigured mobile response must not be cached")
			}
		})
	}
}

func applyMobileTestCookies(jar map[string]*http.Cookie, response *httptest.ResponseRecorder) {
	for _, cookie := range response.Result().Cookies() {
		if cookie.MaxAge < 0 {
			delete(jar, cookie.Name)
		} else {
			jar[cookie.Name] = cookie
		}
	}
}

func mobileCallbackRequest(jar map[string]*http.Cookie) *http.Request {
	request := httptest.NewRequest(http.MethodGet, "https://duallane.example.test/api/auth/github/callback?githubLogin=timeStarry", nil)
	for _, cookie := range jar {
		request.AddCookie(cookie)
	}
	return request
}

func TestBrowserLoginReplacesAbandonedMobileFlow(t *testing.T) {
	handler, repository := mobileTestHandler()
	jar := map[string]*http.Cookie{}
	authorize := httptest.NewRecorder()
	handler.HandleMobileAuthorize(authorize, httptest.NewRequest(http.MethodGet, "/api/auth/mobile/github/authorize?flow="+strings.Repeat("a", 43), nil))
	applyMobileTestCookies(jar, authorize)
	if cookie := jar[mobileFlowCookie]; cookie == nil || cookie.MaxAge != 600 || !cookie.HttpOnly || cookie.Path != OAuthCookiePath || cookie.SameSite != http.SameSiteLaxMode {
		t.Fatal("mobile flow cookie is missing its expiry or browser isolation")
	}
	webStart := httptest.NewRecorder()
	handler.HandleGitHubStart(webStart, httptest.NewRequest(http.MethodGet, "/api/auth/github/start", nil))
	applyMobileTestCookies(jar, webStart)
	callback := httptest.NewRecorder()
	handler.HandleGitHubCallback(callback, mobileCallbackRequest(jar))
	applyMobileTestCookies(jar, callback)
	if callback.Code != http.StatusFound || repository.authorized || jar[SessionCookieName] == nil || jar[mobileFlowCookie] != nil {
		t.Fatalf("browser login = %d, location %q, authorized %v, cookies %v", callback.Code, callback.Header().Get("Location"), repository.authorized, jar)
	}
}

func TestMobileCallbackBindsOAuthStateAndClearsContext(t *testing.T) {
	for _, mismatch := range []bool{false, true} {
		t.Run(map[bool]string{false: "matching", true: "mismatched"}[mismatch], func(t *testing.T) {
			handler, repository := mobileTestHandler()
			jar := map[string]*http.Cookie{}
			authorize := httptest.NewRecorder()
			handler.HandleMobileAuthorize(authorize, httptest.NewRequest(http.MethodGet, "/api/auth/mobile/github/authorize?flow="+strings.Repeat("a", 43)+"&invite=DL-INVITE", nil))
			applyMobileTestCookies(jar, authorize)
			if mismatch {
				jar[OAuthStateCookieName].Value = "different-oauth-start"
			}
			callback := httptest.NewRecorder()
			handler.HandleGitHubCallback(callback, mobileCallbackRequest(jar))
			applyMobileTestCookies(jar, callback)
			if jar[mobileFlowCookie] != nil || jar[PendingInviteCookieName] != nil || jar[SessionCookieName] != nil {
				t.Fatalf("mobile callback retained login context or created browser session: %v", jar)
			}
			if mismatch {
				if callback.Code != http.StatusUnauthorized || repository.authorized || len(repository.audits) != 1 {
					t.Fatalf("mismatched callback = %d %s, authorized %v", callback.Code, callback.Body.String(), repository.authorized)
				}
				return
			}
			location, err := url.Parse(callback.Header().Get("Location"))
			if err != nil || callback.Code != http.StatusFound || !repository.authorized || location.Query().Get("state") != repository.flow.ClientState || !challengePattern.MatchString(location.Query().Get("code")) {
				t.Fatalf("mobile callback = %d %s, location %v, err %v", callback.Code, callback.Body.String(), location, err)
			}
		})
	}
}

func TestMobileRejectedProviderCallbackClearsContext(t *testing.T) {
	handler, repository := mobileTestHandler()
	handler.Environment = ProductionEnvironment
	request := httptest.NewRequest(http.MethodGet, "/api/auth/github/callback?code=provider-code&state=wrong-state", nil)
	request.AddCookie(&http.Cookie{Name: OAuthStateCookieName, Value: "correct-state"})
	request.AddCookie(&http.Cookie{Name: mobileFlowCookie, Value: "abandoned-flow"})
	response := httptest.NewRecorder()
	handler.HandleGitHubCallback(response, request)
	jar := map[string]*http.Cookie{mobileFlowCookie: {Name: mobileFlowCookie, Value: "abandoned-flow"}}
	applyMobileTestCookies(jar, response)
	if response.Code != http.StatusBadRequest || repository.authorized || jar[mobileFlowCookie] != nil {
		t.Fatalf("rejected callback = %d %s, cookie %v", response.Code, response.Body.String(), jar[mobileFlowCookie])
	}
}

func TestMobileTokenFailuresPreserveTemporaryServerErrors(t *testing.T) {
	for _, operation := range []string{"exchange", "refresh"} {
		for _, temporary := range []bool{false, true} {
			t.Run(operation+map[bool]string{false: "-invalid", true: "-unavailable"}[temporary], func(t *testing.T) {
				handler, repository := mobileTestHandler()
				repository.err = errMobileInvalid
				want := http.StatusUnauthorized
				if temporary {
					repository.err = errors.New("database temporarily unavailable with private details")
					want = http.StatusInternalServerError
				}
				body := `{"refreshToken":"` + strings.Repeat("a", 43) + `","code":"` + strings.Repeat("a", 43) + `","codeVerifier":"` + strings.Repeat("a", 43) + `","redirectUri":"` + MobileRedirectURI + `"}`
				request := httptest.NewRequest(http.MethodPost, "/api/auth/mobile/"+operation, strings.NewReader(body))
				response := httptest.NewRecorder()
				if operation == "exchange" {
					handler.HandleMobileExchange(response, request)
				} else {
					handler.HandleMobileRefresh(response, request)
				}
				if response.Code != want || strings.Contains(response.Body.String(), "private details") || response.Header().Get("Cache-Control") != "no-store" {
					t.Fatalf("response = %d %s", response.Code, response.Body.String())
				}
				if !temporary && (len(repository.audits) != 1 || repository.audits[0] != operation) {
					t.Fatalf("missing rejection audit: %v", repository.audits)
				}
			})
		}
	}
}

func TestMobileAuditFailureFailsClosed(t *testing.T) {
	handler, repository := mobileTestHandler()
	repository.err = errMobileInvalid
	repository.auditErr = errors.New("audit unavailable")
	response := httptest.NewRecorder()
	handler.HandleMobileRefresh(response, httptest.NewRequest(http.MethodPost, "/api/auth/mobile/refresh", strings.NewReader(`{"refreshToken":"`+strings.Repeat("a", 43)+`"}`)))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("audit failure = %d %s", response.Code, response.Body.String())
	}
}

func TestMobileDisabledDoesNotAccessRepository(t *testing.T) {
	handler := NewHTTPHandler(HTTPHandler{WorkspaceEnabled: func() bool { return false }, Mobile: &MobileService{Repository: &mobileTestRepository{}}})
	response := httptest.NewRecorder()
	handler.HandleMobileRefresh(response, httptest.NewRequest(http.MethodPost, "/api/auth/mobile/refresh", strings.NewReader(`{}`)))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("disabled = %d %s", response.Code, response.Body.String())
	}
}

func TestMobilePKCEValidation(t *testing.T) {
	verifier := strings.Repeat("a", 43)
	digest := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(digest[:])
	if !verifyPKCE(verifier, challenge) || verifyPKCE(strings.Repeat("b", 43), challenge) || verifyPKCE("short", challenge) {
		t.Fatal("PKCE accepted invalid verifier or rejected matching S256 verifier")
	}
}
