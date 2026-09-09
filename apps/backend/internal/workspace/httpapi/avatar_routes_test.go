package httpapi

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/avatars"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
)

type avatarRouteTestResolver struct {
	actor *auth.Actor
	err   error
}

func (r avatarRouteTestResolver) ResolveActor(context.Context, *http.Request) (*auth.Actor, error) {
	return r.actor, r.err
}

type avatarRouteTestService struct {
	setResult    avatars.AvatarMutationResult
	setErr       error
	removeResult avatars.AvatarMutationResult
	removeErr    error
	opened       platformstorage.OpenedObject
	openErr      error
	setCalls     int
	removeCalls  int
	openCalls    int
	setInput     avatars.SetOwnAvatarInput
	removeInput  avatars.RemoveOwnAvatarInput
	openInput    avatars.GetProfileAvatarInput
	openMaxBytes int64
}

func (s *avatarRouteTestService) SetOwnAvatar(_ context.Context, input avatars.SetOwnAvatarInput) (avatars.AvatarMutationResult, error) {
	s.setCalls++
	s.setInput = input
	return s.setResult, s.setErr
}

func (s *avatarRouteTestService) RemoveOwnAvatar(_ context.Context, input avatars.RemoveOwnAvatarInput) (avatars.AvatarMutationResult, error) {
	s.removeCalls++
	s.removeInput = input
	return s.removeResult, s.removeErr
}

func (s *avatarRouteTestService) OpenProfileAvatar(_ context.Context, input avatars.GetProfileAvatarInput, maxBytes int64) (platformstorage.OpenedObject, error) {
	s.openCalls++
	s.openInput = input
	s.openMaxBytes = maxBytes
	return s.opened, s.openErr
}

func newAvatarRouteTestHandler(service AvatarService) http.Handler {
	router := chi.NewRouter()
	router.Route("/api/workspace", func(workspace chi.Router) {
		RegisterAvatarRoutes(workspace, AvatarRouteOptions{
			Service: service,
			ActorResolver: avatarRouteTestResolver{actor: &auth.Actor{
				ID: "usr_avatar_route", Kind: "human", Role: "member", GitHubLogin: "avatar-route",
			}},
			TrustProxy: true,
		})
	})
	return router
}

func avatarRouteTestActor() *auth.Actor {
	return &auth.Actor{
		ID: "usr_avatar_route", Kind: "human", Role: "member", GitHubLogin: "avatar-route",
		DisplayName: "Avatar Route", AvatarURL: "/api/workspace/avatars/usr_avatar_route/v1",
	}
}

func TestAvatarRoutesSetDeleteAndGetUseSafeContracts(t *testing.T) {
	service := &avatarRouteTestService{
		setResult:    avatars.AvatarMutationResult{User: avatarRouteTestActor()},
		removeResult: avatars.AvatarMutationResult{User: avatarRouteTestActor()},
		opened: platformstorage.OpenedObject{
			Object: platformstorage.Object{
				ByteSize:    int64(len("webp-bytes")),
				ContentType: avatars.AvatarContentType,
			},
			Body: io.NopCloser(strings.NewReader("webp-bytes")),
		},
	}
	handler := newAvatarRouteTestHandler(service)

	setRequest := httptest.NewRequest(http.MethodPut, "/api/workspace/me/avatar", strings.NewReader("source-image"))
	setRequest.ContentLength = int64(len("source-image"))
	setRequest.Header.Set("Content-Type", "IMAGE/PNG")
	setRequest.Header.Set("X-Request-ID", "avatar-route-request")
	setRequest.RemoteAddr = "192.0.2.10:4242"
	setResponse := httptest.NewRecorder()
	handler.ServeHTTP(setResponse, setRequest)
	if setResponse.Code != http.StatusOK || !strings.Contains(setResponse.Body.String(), `"avatarUrl"`) {
		t.Fatalf("set response = %d %s", setResponse.Code, setResponse.Body.String())
	}
	if service.setCalls != 1 || service.setInput.ActorID != "usr_avatar_route" || service.setInput.MIMEType != "image/png" || string(service.setInput.Content) != "source-image" {
		t.Fatalf("set input = %#v, calls=%d", service.setInput, service.setCalls)
	}
	if service.setInput.Meta.RequestID != "avatar-route-request" || service.setInput.Meta.IPAddress != "192.0.2.10" {
		t.Fatalf("set metadata = %#v", service.setInput.Meta)
	}

	deleteRequest := httptest.NewRequest(http.MethodDelete, "/api/workspace/me/avatar", nil)
	deleteResponse := httptest.NewRecorder()
	handler.ServeHTTP(deleteResponse, deleteRequest)
	if deleteResponse.Code != http.StatusOK || service.removeCalls != 1 || service.removeInput.ActorID != "usr_avatar_route" {
		t.Fatalf("delete response = %d %s, calls=%d input=%#v", deleteResponse.Code, deleteResponse.Body.String(), service.removeCalls, service.removeInput)
	}

	getRequest := httptest.NewRequest(http.MethodGet, "/api/workspace/avatars/usr_target/v42", nil)
	getResponse := httptest.NewRecorder()
	handler.ServeHTTP(getResponse, getRequest)
	if getResponse.Code != http.StatusOK || getResponse.Body.String() != "webp-bytes" {
		t.Fatalf("get response = %d %q", getResponse.Code, getResponse.Body.String())
	}
	if getResponse.Header().Get("Content-Type") != avatars.AvatarContentType || getResponse.Header().Get("Content-Disposition") != "inline" || getResponse.Header().Get("Cache-Control") == "" {
		t.Fatalf("get headers = %#v", getResponse.Header())
	}
	if service.openCalls != 1 || service.openInput.ActorID != "usr_avatar_route" || service.openInput.UserID != "usr_target" || service.openInput.Version != "v42" || service.openMaxBytes != avatars.AvatarMaxOutputBytes {
		t.Fatalf("open input = %#v max=%d calls=%d", service.openInput, service.openMaxBytes, service.openCalls)
	}
}

func TestAvatarRoutesRejectDeclaredAndUnknownLengthOveragesBeforeService(t *testing.T) {
	service := &avatarRouteTestService{setErr: errors.New("sensitive sha256 /private/avatar")}
	handler := newAvatarRouteTestHandler(service)

	declared := httptest.NewRequest(http.MethodPut, "/api/workspace/me/avatar", strings.NewReader("small"))
	declared.ContentLength = avatars.AvatarMaxInputBytes + 1
	declaredResponse := httptest.NewRecorder()
	handler.ServeHTTP(declaredResponse, declared)
	if declaredResponse.Code != http.StatusBadRequest || service.setCalls != 0 || !strings.Contains(declaredResponse.Body.String(), avatars.CodeAvatarInvalidSize) || !strings.Contains(declaredResponse.Body.String(), avatars.MessageAvatarInvalidSize) {
		t.Fatalf("declared overage = %d %s, calls=%d", declaredResponse.Code, declaredResponse.Body.String(), service.setCalls)
	}
	if strings.Contains(declaredResponse.Body.String(), "sha256") || strings.Contains(declaredResponse.Body.String(), "/private") {
		t.Fatalf("declared overage leaked sensitive detail: %s", declaredResponse.Body.String())
	}

	unknownLengthBody := io.LimitReader(strings.NewReader(strings.Repeat("x", int(avatars.AvatarMaxInputBytes)+1)), avatars.AvatarMaxInputBytes+1)
	unknownLength := httptest.NewRequest(http.MethodPut, "/api/workspace/me/avatar", unknownLengthBody)
	unknownLength.ContentLength = -1
	unknownLengthResponse := httptest.NewRecorder()
	handler.ServeHTTP(unknownLengthResponse, unknownLength)
	if unknownLengthResponse.Code != http.StatusBadRequest || service.setCalls != 0 || !strings.Contains(unknownLengthResponse.Body.String(), avatars.CodeAvatarInvalidSize) || !strings.Contains(unknownLengthResponse.Body.String(), avatars.MessageAvatarInvalidSize) {
		t.Fatalf("unknown-length overage = %d %s, calls=%d", unknownLengthResponse.Code, unknownLengthResponse.Body.String(), service.setCalls)
	}

	mismatch := httptest.NewRequest(http.MethodPut, "/api/workspace/me/avatar", strings.NewReader("four"))
	mismatch.ContentLength = 3
	mismatch.Header.Set("Content-Type", "image/png")
	mismatchResponse := httptest.NewRecorder()
	handler.ServeHTTP(mismatchResponse, mismatch)
	if mismatchResponse.Code != http.StatusBadRequest || service.setCalls != 0 || !strings.Contains(mismatchResponse.Body.String(), avatars.CodeAvatarInvalidSize) {
		t.Fatalf("declared mismatch = %d %s, calls=%d", mismatchResponse.Code, mismatchResponse.Body.String(), service.setCalls)
	}
}

func TestAvatarRoutesRedactServiceErrors(t *testing.T) {
	service := &avatarRouteTestService{setErr: &avatars.Error{
		Code:       avatars.CodeAvatarStorageFailed,
		Message:    avatars.MessageAvatarStorageFailed,
		StatusCode: http.StatusInternalServerError,
		Cause:      errors.New("filesystem /private/avatar/sha256-secret"),
	}}
	handler := newAvatarRouteTestHandler(service)
	request := httptest.NewRequest(http.MethodPut, "/api/workspace/me/avatar", strings.NewReader("source"))
	request.Header.Set("Content-Type", "image/png")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("error response status = %d, body=%s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	if strings.Contains(body, "filesystem") || strings.Contains(body, "/private") || strings.Contains(body, "sha256-secret") {
		t.Fatalf("service error leaked private detail: %s", body)
	}
	if !strings.Contains(body, avatars.CodeAvatarStorageFailed) || !strings.Contains(body, avatars.MessageAvatarStorageFailed) {
		t.Fatalf("safe service error missing contract: %s", body)
	}
}

func TestAvatarRootRouterRequiresExactWorkspaceGateBeforeBodyAndAuth(t *testing.T) {
	for _, flag := range []string{"", "false", "TRUE", " true", "true "} {
		for _, endpoint := range []struct{ method, path string }{
			{http.MethodPut, "/api/workspace/me/avatar"},
			{http.MethodDelete, "/api/workspace/me/avatar"},
			{http.MethodGet, "/api/workspace/avatars/user/version"},
		} {
			service := &avatarRouteTestService{}
			resolver := &fakeResolver{actor: avatarRouteTestActor()}
			router := NewRouter(RouterOptions{Gate: gate.New(flag), Avatars: service, ActorResolver: resolver})
			request := httptest.NewRequest(endpoint.method, endpoint.path, nil)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != http.StatusServiceUnavailable || resolver.calls != 0 || service.setCalls+service.removeCalls+service.openCalls != 0 {
				t.Fatalf("disabled avatar route used a dependency: flag=%q method=%s status=%d", flag, endpoint.method, response.Code)
			}
		}
	}
}
