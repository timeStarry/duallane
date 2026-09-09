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
	"github.com/timestarry/duallane/apps/backend/internal/workspace/ntfy"
)

type ntfyServiceStub struct {
	preferences ntfy.Preferences
	update      ntfy.UpdatePreferencesInput
	rotate      ntfy.RotateTopicInput
	err         error
}

func (stub *ntfyServiceStub) GetPreferences(context.Context, string) (ntfy.Preferences, error) {
	return stub.preferences, stub.err
}

func (stub *ntfyServiceStub) UpdatePreferences(_ context.Context, input ntfy.UpdatePreferencesInput) (ntfy.Preferences, error) {
	stub.update = input
	return stub.preferences, stub.err
}

func (stub *ntfyServiceStub) RotateTopic(_ context.Context, input ntfy.RotateTopicInput) (ntfy.Preferences, error) {
	stub.rotate = input
	return stub.preferences, stub.err
}

func ntfyRoutesRouter(service NtfyService) http.Handler {
	return NewRouter(RouterOptions{
		Gate: gate.New("true"), ActorResolver: &fakeResolver{actor: &auth.Actor{ID: "actor-1", Kind: "human", Role: "member"}},
		Ntfy: service, TrustProxy: true,
	})
}

func TestNtfyRoutesPreservePreferencesContract(t *testing.T) {
	service := &ntfyServiceStub{preferences: ntfy.Preferences{Enabled: true, Topic: "duallane-user-ABC123"}}
	router := ntfyRoutesRouter(service)

	get := httptest.NewRecorder()
	router.ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/api/workspace/me/ntfy", nil))
	if get.Code != http.StatusOK || !strings.Contains(get.Body.String(), `"topic":"duallane-user-ABC123"`) {
		t.Fatalf("get status=%d body=%s", get.Code, get.Body.String())
	}

	update := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPatch, "/api/workspace/me/ntfy", strings.NewReader(`{"enabled":false}`))
	request.Header.Set("content-type", "application/json")
	router.ServeHTTP(update, request)
	if update.Code != http.StatusOK || service.update.ActorID != "actor-1" || !service.update.EnabledSet || service.update.Enabled == nil || *service.update.Enabled {
		t.Fatalf("update status=%d input=%#v body=%s", update.Code, service.update, update.Body.String())
	}

	rotate := httptest.NewRecorder()
	router.ServeHTTP(rotate, httptest.NewRequest(http.MethodPost, "/api/workspace/me/ntfy/rotate", nil))
	if rotate.Code != http.StatusOK || service.rotate.ActorID != "actor-1" {
		t.Fatalf("rotate status=%d input=%#v body=%s", rotate.Code, service.rotate, rotate.Body.String())
	}
}

func TestNtfyRoutesPreserveOmittedEnabledAndRedactErrors(t *testing.T) {
	service := &ntfyServiceStub{preferences: ntfy.Preferences{Enabled: true}}
	router := ntfyRoutesRouter(service)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPatch, "/api/workspace/me/ntfy", strings.NewReader(`{}`))
	request.Header.Set("content-type", "application/json")
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK || service.update.EnabledSet || service.update.Enabled != nil {
		t.Fatalf("omitted update status=%d input=%#v", response.Code, service.update)
	}

	service.err = &ntfy.Error{Code: ntfy.CodeProviderUnavailable, Message: ntfy.MessageProviderUnavailable, StatusCode: http.StatusServiceUnavailable, Cause: errors.New("provider secret")}
	response = httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/workspace/me/ntfy", nil))
	if response.Code != http.StatusServiceUnavailable || strings.Contains(response.Body.String(), "provider secret") {
		t.Fatalf("error status=%d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil || payload.Error.Code != ntfy.CodeProviderUnavailable {
		t.Fatalf("error payload=%#v err=%v", payload, err)
	}
}
