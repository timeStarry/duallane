package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/bots"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
)

type botServiceStub struct {
	BotService
	createInput     bots.CreateInput
	issueInput      bots.IssueTokenInput
	groupInput      bots.UpdateGroupPolicyInput
	created         bots.Bot
	issued          bots.IssuedToken
	err             error
	createCalls     int
	issueCalls      int
	groupPatchCalls int
}

func (service *botServiceStub) CreateBot(_ context.Context, input bots.CreateInput) (bots.Bot, error) {
	service.createCalls++
	service.createInput = input
	return service.created, service.err
}

func (service *botServiceStub) IssueToken(_ context.Context, input bots.IssueTokenInput) (bots.IssuedToken, error) {
	service.issueCalls++
	service.issueInput = input
	return service.issued, service.err
}

func (service *botServiceStub) UpdateGroupPolicy(_ context.Context, input bots.UpdateGroupPolicyInput) (bots.GroupPolicy, error) {
	service.groupPatchCalls++
	service.groupInput = input
	return bots.GroupPolicy{ConversationID: input.ConversationID, Status: input.Status}, service.err
}

func botRouter(service BotService) http.Handler {
	return NewRouter(RouterOptions{
		Gate:          gate.New("true"),
		ActorResolver: &fakeResolver{actor: &auth.Actor{ID: "owner", Kind: "human", Role: "owner"}},
		Bots:          service,
		TrustProxy:    true,
	})
}

func TestCreateBotUsesAuthenticatedActorAndKeepsLegacyResponse(t *testing.T) {
	service := &botServiceStub{created: bots.Bot{ID: "bot-1", OwnerUserID: "owner", Name: "Release Bot", Status: bots.BotStatusActive}}
	router := botRouter(service)
	request := httptest.NewRequest(http.MethodPost, "/api/workspace/bots", strings.NewReader(`{"name":"Release Bot"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Request-ID", "bot-create-request")
	request.Header.Set("X-Forwarded-For", "203.0.113.9, 10.0.0.2")
	response := httptest.NewRecorder()

	router.ServeHTTP(response, request)

	if response.Code != http.StatusCreated || !strings.Contains(response.Body.String(), `"bot":{"id":"bot-1"`) {
		t.Fatalf("create response = %d %s", response.Code, response.Body.String())
	}
	if service.createInput.ActorID != "owner" || service.createInput.Name != "Release Bot" || service.createInput.Meta.RequestID != "bot-create-request" || service.createInput.Meta.IPAddress != "203.0.113.9" {
		t.Fatalf("create input = %#v", service.createInput)
	}
}

func TestIssueBotTokenReturnsRawCredentialOnlyAtTopLevel(t *testing.T) {
	service := &botServiceStub{issued: bots.IssuedToken{
		Raw:   "dl_bot_once-only-secret",
		Token: bots.Token{ID: "btk-1", BotID: "bot-1", Scopes: []string{"messages:send"}, CreatedAt: "2026-09-04T12:00:00.000Z"},
	}}
	router := botRouter(service)
	request := httptest.NewRequest(http.MethodPost, "/api/workspace/bots/bot-1/tokens", strings.NewReader(`{"scopes":["messages:send"]}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()

	router.ServeHTTP(response, request)

	body := response.Body.String()
	if response.Code != http.StatusCreated || !strings.Contains(body, `"token":"dl_bot_once-only-secret"`) || !strings.Contains(body, `"tokenRecord":{"id":"btk-1"`) {
		t.Fatalf("issue response = %d %s", response.Code, body)
	}
	if strings.Count(body, "dl_bot_once-only-secret") != 1 || strings.Contains(body, `"tokenRecord":{"token"`) {
		t.Fatalf("raw token leaked into projection = %s", body)
	}
	if service.issueInput.ActorID != "owner" || service.issueInput.BotID != "bot-1" || len(service.issueInput.Scopes) != 1 || service.issueInput.Scopes[0] != "messages:send" {
		t.Fatalf("issue input = %#v", service.issueInput)
	}
}

func TestBotRoutesRejectInvalidShapesBeforeCallingDomain(t *testing.T) {
	service := &botServiceStub{}
	router := botRouter(service)
	tests := []struct {
		name   string
		method string
		path   string
		body   string
	}{
		{name: "missing create name", method: http.MethodPost, path: "/api/workspace/bots", body: `{"displayName":"missing"}`},
		{name: "invalid token scopes", method: http.MethodPost, path: "/api/workspace/bots/bot-1/tokens", body: `{"scopes":"messages:send"}`},
		{name: "unknown token field", method: http.MethodPost, path: "/api/workspace/bots/bot-1/tokens", body: `{"secret":"must-not-pass"}`},
		{name: "invalid group boolean", method: http.MethodPatch, path: "/api/workspace/bots/bot-1/group-policies/conversation-1", body: `{"allowContext":"yes"}`},
		{name: "invalid group integer", method: http.MethodPatch, path: "/api/workspace/bots/bot-1/group-policies/conversation-1", body: `{"maxMessages":1.5}`},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequest(testCase.method, testCase.path, strings.NewReader(testCase.body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"code":"bot.invalid_request"`) {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
		})
	}
	if service.createCalls != 0 || service.issueCalls != 0 || service.groupPatchCalls != 0 {
		t.Fatalf("domain calls = create:%d issue:%d group:%d", service.createCalls, service.issueCalls, service.groupPatchCalls)
	}
}

func TestBotRoutesAllowEmptyTokenBodyAndRedactInternalErrors(t *testing.T) {
	service := &botServiceStub{err: errors.New("postgres://bot:secret@database/private")}
	router := botRouter(service)
	response := httptest.NewRecorder()

	router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/workspace/bots/bot-1/tokens", nil))

	if service.issueCalls != 1 || response.Code != http.StatusInternalServerError {
		t.Fatalf("empty body response = calls:%d status:%d body:%s", service.issueCalls, response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "postgres") || strings.Contains(response.Body.String(), "secret") {
		t.Fatalf("unsafe internal error = %s", response.Body.String())
	}
}

func TestBotTransitionWithoutServiceReturnsSafeDependencyError(t *testing.T) {
	router := botRouter(nil)
	response := httptest.NewRecorder()

	router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/workspace/bots/bot-1/pause", nil))

	if response.Code != http.StatusInternalServerError || !strings.Contains(response.Body.String(), `"code":"internal.error"`) {
		t.Fatalf("missing service response = %d %s", response.Code, response.Body.String())
	}
}
