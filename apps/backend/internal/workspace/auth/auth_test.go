package auth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeStore struct {
	actors       map[string]*Actor
	sessions     map[string]SessionRecord
	revoked      map[string]time.Time
	authenticate func(GitHubProfile, string, time.Time) (*Actor, error)
	rejections   []string
	lastMeta     RequestMeta
	revokeCalls  int
	auditEvents  []fakeAudit
}

type fakeAudit struct {
	Action     string
	TargetType string
	TargetID   string
	Result     string
	Reason     string
	Meta       RequestMeta
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		actors:   make(map[string]*Actor),
		sessions: make(map[string]SessionRecord),
		revoked:  make(map[string]time.Time),
	}
}

func (f *fakeStore) CreateSession(_ context.Context, record SessionRecord) error {
	actor := f.actors[record.UserID]
	if actor == nil || actor.Kind != "human" || actor.Role == "" {
		return ErrSessionActorUnavailable
	}
	f.sessions[record.TokenHash] = record
	return nil
}

func (f *fakeStore) LookupSessionActor(_ context.Context, tokenHash string, now time.Time) (*Actor, error) {
	record, ok := f.sessions[tokenHash]
	if !ok || !record.ExpiresAt.After(now) {
		return nil, nil
	}
	if _, ok := f.revoked[tokenHash]; ok {
		return nil, nil
	}
	actor := f.actors[record.UserID]
	if actor == nil || actor.Kind != "human" || actor.Role == "" {
		return nil, nil
	}
	copy := *actor
	return &copy, nil
}

func (f *fakeStore) LookupActiveActorByID(_ context.Context, userID string) (*Actor, error) {
	actor := f.actors[userID]
	if actor == nil || actor.Kind != "human" || actor.Role == "" {
		return nil, nil
	}
	copy := *actor
	return &copy, nil
}

func (f *fakeStore) RevokeSession(_ context.Context, tokenHash string, now time.Time) (bool, error) {
	f.revokeCalls++
	if _, ok := f.sessions[tokenHash]; !ok {
		return false, nil
	}
	if _, ok := f.revoked[tokenHash]; ok {
		return false, nil
	}
	f.revoked[tokenHash] = now
	return true, nil
}

func (f *fakeStore) AuthenticateGitHub(_ context.Context, profile GitHubProfile, inviteCodeHash string, now time.Time, meta RequestMeta) (*Actor, error) {
	f.lastMeta = meta
	if f.authenticate == nil {
		return nil, requiredError()
	}
	actor, err := f.authenticate(profile, inviteCodeHash, now)
	if err != nil {
		f.auditEvents = append(f.auditEvents, fakeAudit{
			Action:     "login.rejected",
			TargetType: "user",
			Result:     "rejected",
			Reason:     CodeGitHubFailed,
			Meta:       meta,
		})
		return nil, err
	}
	f.auditEvents = append(f.auditEvents, fakeAudit{
		Action:     "login.success",
		TargetType: "user",
		TargetID:   actor.ID,
		Result:     "success",
		Meta:       meta,
	})
	return actor, nil
}

func (f *fakeStore) RecordGitHubLoginRejection(_ context.Context, phase string, _ time.Time, meta RequestMeta) error {
	f.rejections = append(f.rejections, phase)
	f.lastMeta = meta
	f.auditEvents = append(f.auditEvents, fakeAudit{
		Action:     "login.rejected",
		TargetType: "github_oauth",
		TargetID:   phase,
		Result:     "rejected",
		Reason:     CodeGitHubFailed,
		Meta:       meta,
	})
	return nil
}

func (f *fakeStore) RecordInviteAcceptRejection(_ context.Context, reason string, _ time.Time, meta RequestMeta) error {
	f.rejections = append(f.rejections, reason)
	f.lastMeta = meta
	f.auditEvents = append(f.auditEvents, fakeAudit{
		Action: "invite.accept", TargetType: "invite", Result: "rejected", Reason: reason, Meta: meta,
	})
	return nil
}

func TestSessionTokenAndHashContract(t *testing.T) {
	token, err := NewSessionToken()
	if err != nil {
		t.Fatalf("NewSessionToken: %v", err)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		t.Fatalf("decode token: %v", err)
	}
	if len(decoded) != SessionTokenBytes {
		t.Fatalf("decoded token length = %d, want %d", len(decoded), SessionTokenBytes)
	}
	if strings.ContainsAny(token, "=+/\n\r") {
		t.Fatalf("token is not unpadded base64url: %q", token)
	}
	if HashSecret(token) == token || len(HashSecret(token)) != 64 {
		t.Fatalf("session hash does not look like SHA-256 hex")
	}
}

func TestServiceSessionChecksMembershipExpiryAndRevocation(t *testing.T) {
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.actors["usr_member"] = &Actor{ID: "usr_member", Kind: "human", Role: "member"}
	service := NewService(ServiceOptions{
		Store:      store,
		SessionTTL: time.Hour,
		Now:        func() time.Time { return now },
		IDFactory:  func() (string, error) { return "ses_test", nil },
	})
	session, err := service.CreateSession(context.Background(), "usr_member")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if session.ExpiresAt != now.Add(time.Hour) {
		t.Fatalf("expiry = %s, want %s", session.ExpiresAt, now.Add(time.Hour))
	}
	record := store.sessions[HashSecret(session.Token)]
	if record.TokenHash == session.Token {
		t.Fatal("raw session token was stored")
	}
	actor, err := service.ResolveActor(context.Background(), session.Token)
	if err != nil || actor.ID != "usr_member" {
		t.Fatalf("ResolveActor = %#v, %v", actor, err)
	}
	if _, err := service.RevokeSession(context.Background(), session.Token); err != nil {
		t.Fatalf("RevokeSession: %v", err)
	}
	if _, err := service.ResolveActor(context.Background(), session.Token); !isCode(err, CodeRequired) {
		t.Fatalf("revoked session error = %v, want auth.required", err)
	}

	store = newFakeStore()
	store.actors["usr_member"] = &Actor{ID: "usr_member", Kind: "human", Role: "member"}
	service = NewService(ServiceOptions{Store: store, SessionTTL: time.Minute, Now: func() time.Time { return now }, IDFactory: func() (string, error) { return "ses_expired", nil }})
	session, err = service.CreateSession(context.Background(), "usr_member")
	if err != nil {
		t.Fatalf("CreateSession expired fixture: %v", err)
	}
	store.sessions[HashSecret(session.Token)] = SessionRecord{
		ID:        session.ID,
		TokenHash: HashSecret(session.Token),
		UserID:    session.UserID,
		CreatedAt: now.Add(-time.Hour),
		ExpiresAt: now.Add(-time.Second),
	}
	if _, err := service.ResolveActor(context.Background(), session.Token); !isCode(err, CodeRequired) {
		t.Fatalf("expired session error = %v, want auth.required", err)
	}
	store.actors["usr_member"].Role = ""
	if _, err := service.CreateSession(context.Background(), "usr_member"); !isCode(err, CodeRequired) {
		t.Fatalf("inactive membership session error = %v, want auth.required", err)
	}
}

func TestServiceAuthenticatesGitHubWithHashedPendingInvite(t *testing.T) {
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.authenticate = func(profile GitHubProfile, inviteHash string, got time.Time) (*Actor, error) {
		if profile.Login != "member" || inviteHash != HashSecret("DL-INVITE") || !got.Equal(now) {
			return nil, errors.New("unexpected authentication arguments")
		}
		return &Actor{ID: "usr_member", Kind: "human", Role: "member", GitHubLogin: "member"}, nil
	}
	service := NewService(ServiceOptions{Store: store, Now: func() time.Time { return now }})
	actor, err := service.AuthenticateGitHub(context.Background(), GitHubProfile{Login: " member "}, "DL-INVITE")
	if err != nil || actor.ID != "usr_member" {
		t.Fatalf("AuthenticateGitHub = %#v, %v", actor, err)
	}
	if _, err := service.AuthenticateGitHub(context.Background(), GitHubProfile{}, "DL-INVITE"); !isCode(err, CodeInvalidProfile) {
		t.Fatalf("invalid profile error = %v", err)
	}
}

func TestDevelopmentInviteAcceptCreatesSessionWithoutLeakingCode(t *testing.T) {
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	store := newFakeStore()
	actor := &Actor{ID: "usr_invited", GitHubLogin: "invited", DisplayName: "Invited", Kind: "human", Role: "member", JoinedAt: now}
	store.actors[actor.ID] = actor
	store.authenticate = func(profile GitHubProfile, inviteHash string, _ time.Time) (*Actor, error) {
		if profile.Login != "invited" || profile.Email != "invited@example.test" || inviteHash != HashSecret("SECRET-INVITE") {
			return nil, errors.New("unexpected invite authentication input")
		}
		return actor, nil
	}
	service := NewService(ServiceOptions{
		Store: store, Now: func() time.Time { return now }, IDFactory: func() (string, error) { return "session-invite", nil },
	})
	handler := NewHTTPHandler(HTTPHandler{Service: service, Environment: "development", TrustProxy: true})
	request := httptest.NewRequest(http.MethodPost, "/api/workspace/invites/SECRET-INVITE/accept", strings.NewReader(`{"githubLogin":"invited","email":"invited@example.test","displayName":"Invited"}`))
	request.Header.Set("X-Request-ID", "accept-request")
	request.Header.Set("X-Forwarded-For", "203.0.113.12")
	request.Header.Set("X-Forwarded-Proto", "https")
	response := httptest.NewRecorder()
	handler.HandleDevelopmentInviteAccept(response, request, "SECRET-INVITE")
	if response.Code != http.StatusCreated || !strings.Contains(response.Body.String(), `"id":"usr_invited"`) {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "SECRET-INVITE") || store.lastMeta.RequestID != "accept-request" || store.lastMeta.IPAddress != "203.0.113.12" {
		t.Fatalf("unsafe response/meta = %s %#v", response.Body.String(), store.lastMeta)
	}
	cookies := response.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != SessionCookieName || !cookies[0].HttpOnly || !cookies[0].Secure || cookies[0].SameSite != http.SameSiteLaxMode {
		t.Fatalf("session cookies = %#v", cookies)
	}
}

func TestProductionInviteAcceptRequiresGitHubAndAuditsWithoutCode(t *testing.T) {
	store := newFakeStore()
	service := NewService(ServiceOptions{Store: store})
	handler := NewHTTPHandler(HTTPHandler{Service: service, Environment: ProductionEnvironment})
	request := httptest.NewRequest(http.MethodPost, "/api/workspace/invites/DO-NOT-STORE/accept", strings.NewReader(`{"githubLogin":"ignored"}`))
	request.Header.Set("X-Request-ID", "production-accept")
	response := httptest.NewRecorder()
	handler.HandleDevelopmentInviteAccept(response, request, "DO-NOT-STORE")
	if response.Code != http.StatusUnauthorized || !strings.Contains(response.Body.String(), `"code":"auth.github_required"`) {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "DO-NOT-STORE") || len(store.auditEvents) != 1 {
		t.Fatalf("unsafe response/audits = %s %#v", response.Body.String(), store.auditEvents)
	}
	audit := store.auditEvents[0]
	if audit.Action != "invite.accept" || audit.TargetType != "invite" || audit.TargetID != "" || audit.Reason != CodeGitHubRequired || audit.Meta.RequestID != "production-accept" {
		t.Fatalf("audit = %#v", audit)
	}
}

func TestAuthAuditMetadataAndContentFreeProjections(t *testing.T) {
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.authenticate = func(profile GitHubProfile, inviteHash string, got time.Time) (*Actor, error) {
		if profile.Login != "member" || inviteHash != HashSecret("INVITE-CODE") || !got.Equal(now) {
			return nil, errors.New("unexpected authentication arguments")
		}
		return &Actor{ID: "usr_member", Kind: "human", Role: "member", GitHubLogin: profile.Login}, nil
	}
	service := NewService(ServiceOptions{Store: store, Now: func() time.Time { return now }})
	meta := RequestMeta{RequestID: "req-auth-42", IPAddress: "203.0.113.7:443", UserAgent: "focused-test"}
	if _, err := service.AuthenticateGitHub(context.Background(), GitHubProfile{Login: "member"}, "INVITE-CODE", meta); err != nil {
		t.Fatalf("AuthenticateGitHub: %v", err)
	}
	if len(store.auditEvents) != 1 || store.auditEvents[0].Action != "login.success" || store.auditEvents[0].TargetID != "usr_member" || store.auditEvents[0].Meta.RequestID != "req-auth-42" || store.auditEvents[0].Meta.IPAddress != "203.0.113.7" {
		t.Fatalf("success audit = %#v", store.auditEvents)
	}
	if err := service.RecordGitHubLoginRejection(context.Background(), "token", meta); err != nil {
		t.Fatalf("RecordGitHubLoginRejection: %v", err)
	}
	if len(store.auditEvents) != 2 || store.auditEvents[1].Action != "login.rejected" || store.auditEvents[1].TargetType != "github_oauth" || store.auditEvents[1].TargetID != "token" || store.auditEvents[1].Reason != CodeGitHubFailed {
		t.Fatalf("rejected audit = %#v", store.auditEvents)
	}
	serialized, err := json.Marshal(store.auditEvents)
	if err != nil {
		t.Fatalf("marshal audits: %v", err)
	}
	for _, secret := range []string{"INVITE-CODE", "oauth-code", "access-token"} {
		if strings.Contains(string(serialized), secret) {
			t.Fatalf("audit contains sensitive value %q: %s", secret, serialized)
		}
	}
	public, err := json.Marshal(withGitHubCause(githubFailedError(), "token", "provider", errors.New("oauth-code access-token")))
	if err != nil {
		t.Fatalf("marshal public error: %v", err)
	}
	if strings.Contains(string(public), "oauth-code") || strings.Contains(string(public), "access-token") {
		t.Fatalf("provider error leaked private cause: %s", public)
	}
}

func TestSessionAndOAuthCookieAttributes(t *testing.T) {
	expires := time.Date(2026, 9, 18, 10, 0, 0, 0, time.UTC)
	sessionCookie := SessionCookie(Session{Token: "token", ExpiresAt: expires}, true)
	if sessionCookie.Name != SessionCookieName || sessionCookie.Path != "/" || !sessionCookie.HttpOnly || !sessionCookie.Secure || sessionCookie.SameSite != http.SameSiteLaxMode || !sessionCookie.Expires.Equal(expires) {
		t.Fatalf("session cookie = %#v", sessionCookie)
	}
	oauthCookie := OAuthCookie(OAuthStateCookieName, "state", true, expires)
	if oauthCookie.Name != OAuthStateCookieName || oauthCookie.Path != OAuthCookiePath || !oauthCookie.HttpOnly || !oauthCookie.Secure || oauthCookie.SameSite != http.SameSiteLaxMode || !oauthCookie.Expires.IsZero() || oauthCookie.MaxAge != 0 {
		t.Fatalf("oauth cookie = %#v", oauthCookie)
	}
	clear := ClearSessionCookie(false)
	if clear.Name != SessionCookieName || clear.Path != "/" || clear.MaxAge != -1 || clear.Value != "" {
		t.Fatalf("clear cookie = %#v", clear)
	}
}

func TestServiceFailsClosedWhenSessionIDFactoryFails(t *testing.T) {
	store := newFakeStore()
	store.actors["usr_member"] = &Actor{ID: "usr_member", Kind: "human", Role: "member"}
	service := NewService(ServiceOptions{
		Store:     store,
		IDFactory: func() (string, error) { return "", errors.New("random source unavailable") },
	})
	if _, err := service.CreateSession(context.Background(), "usr_member"); !isCode(err, "internal.error") {
		t.Fatalf("ID factory error = %v, want internal.error", err)
	}
	if len(store.sessions) != 0 {
		t.Fatalf("session was stored after ID generation failure: %#v", store.sessions)
	}
	service = NewService(ServiceOptions{
		Store:     store,
		IDFactory: func() (string, error) { return "", nil },
	})
	if _, err := service.CreateSession(context.Background(), "usr_member"); !isCode(err, "internal.error") {
		t.Fatalf("empty ID factory result = %v, want internal.error", err)
	}
}

func TestPublicActorMatchesWorkspaceUserProjection(t *testing.T) {
	actor := &Actor{
		ID:                 "usr_member",
		GitHubLogin:        "github-member",
		DisplayName:        "Legacy display",
		Nickname:           "Preferred name",
		Email:              "private@example.com",
		GitHubID:           "private-github-id",
		AvatarURL:          "https://avatars.githubusercontent.com/u/1",
		SearchDiscoverable: true,
		Kind:               "human",
		Role:               "member",
		JoinedAt:           time.Date(2026, 9, 4, 10, 0, 0, 123456000, time.UTC),
	}
	public := PublicActor(actor)
	if public["displayName"] != "Preferred name" || public["nickname"] != "Preferred name" || public["searchDiscoverable"] != true || public["joinedAt"] != "2026-09-04T10:00:00.123Z" {
		t.Fatalf("public actor projection = %#v", public)
	}
	serialized, err := json.Marshal(public)
	if err != nil {
		t.Fatalf("marshal public actor: %v", err)
	}
	for _, secret := range []string{"private@example.com", "private-github-id"} {
		if strings.Contains(string(serialized), secret) {
			t.Fatalf("public actor leaked %q: %s", secret, serialized)
		}
	}
}

func TestPublicMemberProjectionMatchesMemberJoinedEventContract(t *testing.T) {
	member := &Actor{
		ID:                 "usr_member",
		GitHubLogin:        "github-member",
		DisplayName:        "Legacy display",
		Nickname:           "Preferred name",
		AvatarURL:          "https://avatars.githubusercontent.com/u/1",
		SearchDiscoverable: true,
		Kind:               "human",
		Role:               "owner",
		JoinedAt:           time.Date(2026, 9, 4, 10, 0, 0, 123456000, time.UTC),
	}
	public := PublicMemberProjection(member)
	capabilities, ok := public["capabilities"].(map[string]bool)
	if !ok {
		t.Fatalf("capabilities = %#v, want map[string]bool", public["capabilities"])
	}
	wantCapabilities := map[string]bool{
		"canStartDirectConversation": false,
		"canJoinGroups":              true,
		"canManage":                  false,
	}
	if len(capabilities) != len(wantCapabilities) {
		t.Fatalf("capabilities = %#v, want %#v", capabilities, wantCapabilities)
	}
	for key, want := range wantCapabilities {
		if capabilities[key] != want {
			t.Errorf("capabilities[%q] = %v, want %v", key, capabilities[key], want)
		}
	}
	if public["id"] != "usr_member" || public["githubLogin"] != "github-member" || public["nickname"] != "Preferred name" || public["displayName"] != "Preferred name" || public["role"] != "admin" || public["roleLabel"] != "管理员" || public["joinedAt"] != "2026-09-04T10:00:00.123Z" {
		t.Fatalf("public member projection = %#v", public)
	}
	serialized, err := json.Marshal(public)
	if err != nil {
		t.Fatalf("marshal public member: %v", err)
	}
	if strings.Contains(string(serialized), "searchDiscoverable") || strings.Contains(string(serialized), "private") {
		t.Fatalf("member joined projection includes viewer-private fields: %s", serialized)
	}
}

func TestMemberJoinedEventPayloadIncludesPublicMember(t *testing.T) {
	member := &Actor{
		ID:          "usr_member",
		GitHubLogin: "github-member",
		DisplayName: "Member",
		Kind:        "human",
		Role:        "member",
		JoinedAt:    time.Date(2026, 9, 4, 10, 0, 0, 123456000, time.UTC),
	}
	payload, err := memberJoinedEventPayload(member, "inv_1")
	if err != nil {
		t.Fatalf("memberJoinedEventPayload: %v", err)
	}
	var event map[string]any
	if err := json.Unmarshal(payload, &event); err != nil {
		t.Fatalf("decode event payload: %v", err)
	}
	if event["userId"] != "usr_member" || event["role"] != "member" || event["inviteId"] != "inv_1" {
		t.Fatalf("event envelope = %#v", event)
	}
	memberPayload, ok := event["member"].(map[string]any)
	if !ok {
		t.Fatalf("event member = %#v", event["member"])
	}
	if memberPayload["id"] != "usr_member" || memberPayload["githubLogin"] != "github-member" || memberPayload["displayName"] != "github-member" || memberPayload["role"] != "member" || memberPayload["roleLabel"] != "成员" || memberPayload["joinedAt"] != "2026-09-04T10:00:00.123Z" {
		t.Fatalf("event member projection = %#v", memberPayload)
	}
}

func TestPGStoreIDFactoryFailsClosed(t *testing.T) {
	store := &PGStore{idFactory: func() (string, error) {
		return "", errors.New("random source unavailable")
	}}
	if _, err := store.newID(); err == nil {
		t.Fatal("newID succeeded after ID factory failure")
	}
	store.idFactory = func() (string, error) { return "", nil }
	if _, err := store.newID(); err == nil {
		t.Fatal("newID accepted an empty ID")
	}
}

func TestHTTPDevelopmentLoginIsNotAvailableInProduction(t *testing.T) {
	store := newFakeStore()
	store.authenticate = func(profile GitHubProfile, _ string, _ time.Time) (*Actor, error) {
		return &Actor{ID: "usr_owner", Kind: "human", Role: "owner", GitHubLogin: profile.Login}, nil
	}
	service := NewService(ServiceOptions{Store: store})
	handler := NewHTTPHandler(HTTPHandler{Service: service, Environment: ProductionEnvironment, PublicBaseURL: "https://duallane.example"})
	request := httptest.NewRequest(http.MethodGet, "/api/auth/github/callback?format=json&githubLogin=timeStarry&email=timestarry%40qq.com", nil)
	response := httptest.NewRecorder()
	handler.HandleGitHubCallback(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusBadRequest)
	}
	if !strings.Contains(response.Body.String(), CodeInvalidState) {
		t.Fatalf("response = %s", response.Body.String())
	}
}

func TestHTTPDevelopmentHeaderResolvesOnlyNonProductionActiveActor(t *testing.T) {
	store := newFakeStore()
	store.actors["usr_member"] = &Actor{ID: "usr_member", Kind: "human", Role: "member"}
	service := NewService(ServiceOptions{Store: store})
	request := httptest.NewRequest(http.MethodGet, "/api/workspace/bootstrap", nil)
	request.Header.Set("X-Workspace-User-ID", "usr_member")
	development := NewHTTPHandler(HTTPHandler{Service: service, Environment: "development"})
	actor, err := development.ResolveActor(context.Background(), request)
	if err != nil || actor == nil || actor.ID != "usr_member" {
		t.Fatalf("development header actor = %#v, %v", actor, err)
	}
	production := NewHTTPHandler(HTTPHandler{Service: service, Environment: ProductionEnvironment})
	if _, err := production.ResolveActor(context.Background(), request); !isCode(err, CodeRequired) {
		t.Fatalf("production header error = %v, want auth.required", err)
	}
	store.actors["usr_member"].Role = ""
	if _, err := development.ResolveActor(context.Background(), request); !isCode(err, CodeRequired) {
		t.Fatalf("inactive development header error = %v, want auth.required", err)
	}
}

func TestHTTPLogoutClearsCookieWithoutDatabaseAccessWhenDisabled(t *testing.T) {
	store := newFakeStore()
	store.actors["usr_member"] = &Actor{ID: "usr_member", Kind: "human", Role: "member"}
	service := NewService(ServiceOptions{Store: store})
	store.sessions[HashSecret("session-token")] = SessionRecord{UserID: "usr_member", ExpiresAt: time.Now().Add(time.Hour)}
	request := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	request.AddCookie(&http.Cookie{Name: SessionCookieName, Value: "session-token"})
	handler := NewHTTPHandler(HTTPHandler{Service: service, WorkspaceEnabled: func() bool { return false }})
	response := httptest.NewRecorder()
	handler.HandleLogout(response, request)
	if response.Code != http.StatusOK || store.revokeCalls != 0 {
		t.Fatalf("disabled logout status=%d revokeCalls=%d body=%s", response.Code, store.revokeCalls, response.Body.String())
	}
	var cleared bool
	for _, cookie := range response.Result().Cookies() {
		if cookie.Name == SessionCookieName && cookie.MaxAge < 0 {
			cleared = true
		}
	}
	if !cleared {
		t.Fatalf("disabled logout did not clear session cookie: %#v", response.Result().Cookies())
	}

	store.revokeCalls = 0
	enabled := NewHTTPHandler(HTTPHandler{Service: service, WorkspaceEnabled: func() bool { return true }})
	response = httptest.NewRecorder()
	enabled.HandleLogout(response, request)
	if response.Code != http.StatusOK || store.revokeCalls != 1 {
		t.Fatalf("enabled logout status=%d revokeCalls=%d body=%s", response.Code, store.revokeCalls, response.Body.String())
	}
}

func TestHTTPGitHubRoutesDoNotTouchCookiesWhenWorkspaceDisabled(t *testing.T) {
	handler := NewHTTPHandler(HTTPHandler{
		WorkspaceEnabled: func() bool { return false },
		Service:          NewService(ServiceOptions{Store: newFakeStore()}),
	})
	startRequest := httptest.NewRequest(http.MethodGet, "/api/auth/github/start?invite=INVITE-1", nil)
	startResponse := httptest.NewRecorder()
	handler.HandleGitHubStart(startResponse, startRequest)
	if startResponse.Code != http.StatusServiceUnavailable || len(startResponse.Result().Cookies()) != 0 {
		t.Fatalf("disabled start status=%d cookies=%#v body=%s", startResponse.Code, startResponse.Result().Cookies(), startResponse.Body.String())
	}

	callbackRequest := httptest.NewRequest(http.MethodGet, "/api/auth/github/callback?code=oauth-code&state=state", nil)
	callbackRequest.AddCookie(&http.Cookie{Name: OAuthStateCookieName, Value: "state"})
	callbackResponse := httptest.NewRecorder()
	handler.HandleGitHubCallback(callbackResponse, callbackRequest)
	if callbackResponse.Code != http.StatusServiceUnavailable || len(callbackResponse.Result().Cookies()) != 0 {
		t.Fatalf("disabled callback status=%d cookies=%#v body=%s", callbackResponse.Code, callbackResponse.Result().Cookies(), callbackResponse.Body.String())
	}
}

func TestHTTPStartPreservesPendingInviteWhenNoNewInviteIsProvided(t *testing.T) {
	handler := NewHTTPHandler(HTTPHandler{
		Environment:   "development",
		PublicBaseURL: "http://127.0.0.1:8787",
	})
	request := httptest.NewRequest(http.MethodGet, "/api/auth/github/start", nil)
	request.AddCookie(&http.Cookie{Name: PendingInviteCookieName, Value: "INVITE-CODE"})
	response := httptest.NewRecorder()
	handler.HandleGitHubStart(response, request)
	if response.Code != http.StatusFound {
		t.Fatalf("start status = %d body=%s", response.Code, response.Body.String())
	}
	for _, cookie := range response.Result().Cookies() {
		if cookie.Name == PendingInviteCookieName {
			t.Fatalf("start changed pending invite without a new invite: %#v", cookie)
		}
	}
}

func TestHTTPDevelopmentCallbackCreatesSessionAndProjectsSafeUser(t *testing.T) {
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.actors["usr_owner"] = &Actor{ID: "usr_owner", Kind: "human", Role: "owner"}
	store.authenticate = func(profile GitHubProfile, inviteHash string, got time.Time) (*Actor, error) {
		if profile.Login != "timeStarry" || inviteHash != HashSecret("INVITE-1") || !got.Equal(now) {
			return nil, errors.New("unexpected development callback")
		}
		return &Actor{ID: "usr_owner", Kind: "human", Role: "owner", GitHubLogin: profile.Login, Email: profile.Email}, nil
	}
	service := NewService(ServiceOptions{Store: store, Now: func() time.Time { return now }, SessionTTL: time.Hour, IDFactory: func() (string, error) { return "session-http", nil }})
	handler := NewHTTPHandler(HTTPHandler{Service: service, Environment: "development", FrontendURL: "http://127.0.0.1:5173/app/", Now: func() time.Time { return now }})
	request := httptest.NewRequest(http.MethodGet, "/api/auth/github/callback?format=json&githubLogin=timeStarry&email=timestarry%40qq.com&displayName=timeStarry", nil)
	request.AddCookie(&http.Cookie{Name: OAuthStateCookieName, Value: "dev-state"})
	request.AddCookie(&http.Cookie{Name: PendingInviteCookieName, Value: "INVITE-1"})
	response := httptest.NewRecorder()
	handler.HandleGitHubCallback(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "timestarry@qq.com") {
		t.Fatalf("private email leaked in public user projection: %s", response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"githubLogin":"timeStarry"`) {
		t.Fatalf("user projection missing github login: %s", response.Body.String())
	}
	cookies := response.Result().Cookies()
	var sessionCookie *http.Cookie
	var pendingClear *http.Cookie
	for _, cookie := range cookies {
		if cookie.Name == SessionCookieName {
			sessionCookie = cookie
		}
		if cookie.Name == PendingInviteCookieName && cookie.MaxAge < 0 {
			pendingClear = cookie
		}
	}
	if sessionCookie == nil || sessionCookie.Path != "/" || !sessionCookie.HttpOnly || sessionCookie.SameSite != http.SameSiteLaxMode || pendingClear == nil {
		t.Fatalf("response cookies = %#v", cookies)
	}
}

func TestOAuthReturnTargetAndProxyValidation(t *testing.T) {
	valid := []string{"/workspace", "/workspace/space/email", "/workspace?invite=INVITE-1"}
	for _, value := range valid {
		if got := NormalizeReturnTarget(value); got != value {
			t.Errorf("NormalizeReturnTarget(%q) = %q", value, got)
		}
	}
	for _, value := range []string{"https://evil.example/workspace", "//evil.example/workspace", "workspace/space", "/workspace#secret", "/workspace\\@example.com", "/workspace/%5c@example.com"} {
		if got := NormalizeReturnTarget(value); got != "" {
			t.Errorf("NormalizeReturnTarget(%q) = %q, want empty", value, got)
		}
	}
	if _, err := NormalizeGitHubProxyURL("http://user:password@proxy:1080"); err == nil {
		t.Fatal("proxy with credentials was accepted")
	}
	for _, value := range []string{"http://proxy:0", "http://proxy:65536", "http://proxy:not-a-port", "http://proxy:1080/%2f"} {
		if _, err := NormalizeGitHubProxyURL(value); err == nil {
			t.Fatalf("invalid proxy %q was accepted", value)
		}
	}
	if _, err := NormalizeGitHubProxyURL("http://proxy:1080"); err != nil {
		t.Fatalf("valid proxy rejected: %v", err)
	}
	if got := ParseGitHubOAuthTimeoutMillis("999999"); got != MaxGitHubOAuthTimeout {
		t.Fatalf("timeout clamp = %s", got)
	}
	if got := ParseGitHubOAuthTimeoutMillis("bad"); got != DefaultGitHubOAuthTimeout {
		t.Fatalf("invalid timeout = %s", got)
	}
	if !validGitHubRedirectURI("http://[::1]:8787/api/auth/github/callback") {
		t.Fatal("IPv6 loopback redirect URI was rejected")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func TestGitHubJSONResponseRejectsOversizeAndTrailingData(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		wantErr bool
	}{
		{name: "valid", body: "{\"login\":\"member\"} \n", wantErr: false},
		{name: "trailing value", body: `{"login":"member"} {"other":"value"}`, wantErr: true},
		{name: "oversize", body: strings.Repeat(" ", MaxGitHubResponseBytes+1), wantErr: true},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			oauth := &GitHubOAuth{client: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				return &http.Response{
					StatusCode: http.StatusOK,
					Body:       io.NopCloser(strings.NewReader(test.body)),
					Header:     make(http.Header),
					Request:    request,
				}, nil
			})}}
			var target map[string]string
			err := oauth.getJSON(context.Background(), GitHubUserEndpoint, "access-token", &target)
			if (err != nil) != test.wantErr {
				t.Fatalf("getJSON error = %v, wantErr=%v", err, test.wantErr)
			}
		})
	}
}
