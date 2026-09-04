package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/invites"
)

type fakeResolver struct {
	actor *auth.Actor
	err   error
	calls int
}

func (resolver *fakeResolver) ResolveActor(_ context.Context, _ *http.Request) (*auth.Actor, error) {
	resolver.calls++
	return resolver.actor, resolver.err
}

type fakeInvites struct {
	createInput invites.CreateInput
	revokeInput invites.RevokeInput
	created     invites.Invite
	revoked     invites.RevokedInvite
	err         error
	calls       int
}

func (service *fakeInvites) Create(_ context.Context, input invites.CreateInput) (invites.Invite, error) {
	service.calls++
	service.createInput = input
	return service.created, service.err
}

func (service *fakeInvites) Revoke(_ context.Context, input invites.RevokeInput) (invites.RevokedInvite, error) {
	service.calls++
	service.revokeInput = input
	return service.revoked, service.err
}

func TestWorkspaceGateRunsBeforeAuthAndDomainDependencies(t *testing.T) {
	resolver := &fakeResolver{actor: &auth.Actor{ID: "owner"}}
	service := &fakeInvites{}
	router := NewRouter(RouterOptions{Gate: gate.New("false"), ActorResolver: resolver, Invites: service})
	request := httptest.NewRequest(http.MethodPost, "/api/workspace/invites", strings.NewReader(`{"code":"SECRET"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable || resolver.calls != 0 || service.calls != 0 {
		t.Fatalf("disabled request = status:%d resolver:%d service:%d body:%s", response.Code, resolver.calls, service.calls, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "SECRET") {
		t.Fatal("disabled response leaked request content")
	}
}

func TestCreateInviteResolvesActorProjectsLinkAndPassesSafeMeta(t *testing.T) {
	resolver := &fakeResolver{actor: &auth.Actor{ID: "owner", Kind: "human", Role: "owner"}}
	expires := "2026-09-05T12:00:00.000Z"
	service := &fakeInvites{created: invites.Invite{
		ID: "invite-1", Code: "ROUTE-INVITE", CodePreview: "ROUT...VITE", DefaultRole: "member",
		MaxUses: 2, ExpiresAt: &expires, CreatedAt: "2026-09-04T12:00:00.000Z",
	}}
	router := NewRouter(RouterOptions{
		Gate: gate.New("true"), ActorResolver: resolver, Invites: service,
		FrontendURL: "http://127.0.0.1:5174/app/", TrustProxy: true,
	})
	request := httptest.NewRequest(http.MethodPost, "/api/workspace/invites", strings.NewReader(`{"code":"ROUTE-INVITE","defaultRole":"member","maxUses":2,"expiresInHours":24}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Forwarded-For", "203.0.113.8, 10.0.0.1")
	request.Header.Set("X-Request-ID", "request-1")
	request.Header.Set("User-Agent", "router-test")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		Invite map[string]any `json:"invite"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Invite["inviteUrl"] != "http://127.0.0.1:5174/workspace?invite=ROUTE-INVITE" || payload.Invite["expiresAt"] != expires {
		t.Fatalf("invite projection = %#v", payload.Invite)
	}
	if service.createInput.ActorID != "owner" || service.createInput.Meta.RequestID != "request-1" || service.createInput.Meta.IPAddress != "203.0.113.8" {
		t.Fatalf("create input = %#v", service.createInput)
	}
}

func TestCreateInviteUsesTrustedRequestOrigin(t *testing.T) {
	resolver := &fakeResolver{actor: &auth.Actor{ID: "owner"}}
	service := &fakeInvites{created: invites.Invite{ID: "invite-1", Code: "ORIGIN-CODE"}}
	router := NewRouter(RouterOptions{Gate: gate.New("true"), ActorResolver: resolver, Invites: service, TrustProxy: true})
	request := httptest.NewRequest(http.MethodPost, "/api/workspace/invites", nil)
	request.Host = "duallane.example"
	request.Header.Set("X-Forwarded-Proto", "https")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusCreated || !strings.Contains(response.Body.String(), `"inviteUrl":"https://duallane.example/workspace?invite=ORIGIN-CODE"`) {
		t.Fatalf("origin response = %d %s", response.Code, response.Body.String())
	}
}

func TestRevokeInviteUsesPathActorAndSafeErrors(t *testing.T) {
	resolver := &fakeResolver{actor: &auth.Actor{ID: "member"}}
	service := &fakeInvites{err: invites.NewError(invites.CodePermissionDenied, "你没有执行该操作的权限", http.StatusForbidden)}
	router := NewRouter(RouterOptions{Gate: gate.New("true"), ActorResolver: resolver, Invites: service})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/workspace/invites/secret-invite-id/revoke", nil))
	if response.Code != http.StatusForbidden || service.revokeInput.ActorID != "member" || service.revokeInput.InviteID != "secret-invite-id" {
		t.Fatalf("revoke = status:%d input:%#v body:%s", response.Code, service.revokeInput, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"code":"permission.denied"`) || strings.Contains(response.Body.String(), "secret-invite-id") {
		t.Fatalf("unsafe revoke error = %s", response.Body.String())
	}

	service.err = errors.New("postgres://user:password@database/private")
	response = httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/workspace/invites/another/revoke", nil))
	if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "postgres") || strings.Contains(response.Body.String(), "password") {
		t.Fatalf("unsafe internal error = %s", response.Body.String())
	}
}

func TestJSONDecoderRejectsOversizedAndTrailingBodies(t *testing.T) {
	resolver := &fakeResolver{actor: &auth.Actor{ID: "owner"}}
	service := &fakeInvites{}
	router := NewRouter(RouterOptions{Gate: gate.New("true"), ActorResolver: resolver, Invites: service})
	for name, testCase := range map[string]struct {
		body string
		code int
	}{
		"trailing":  {body: `{}` + `{}`, code: http.StatusBadRequest},
		"oversized": {body: `{"code":"` + strings.Repeat("A", int(MaxJSONBodyBytes)) + `"}`, code: http.StatusRequestEntityTooLarge},
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/workspace/invites", strings.NewReader(testCase.body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != testCase.code || service.calls != 0 {
				t.Fatalf("response = %d %s calls=%d", response.Code, response.Body.String(), service.calls)
			}
		})
	}
}
