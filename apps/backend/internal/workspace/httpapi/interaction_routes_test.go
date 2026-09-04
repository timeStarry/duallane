package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/interactions"
)

type interactionRouteResolver struct {
	actor *auth.Actor
	calls int
}

func (resolver *interactionRouteResolver) ResolveActor(context.Context, *http.Request) (*auth.Actor, error) {
	resolver.calls++
	return resolver.actor, nil
}

type interactionRouteService struct {
	commandResult  interactions.CommandOutcome
	workflowResult interactions.Workflow
	continueResult interactions.WorkflowOutcome
	commandErr     error
	startErr       error
	getErr         error
	continueErr    error
	cancelErr      error
	commandIn      interactions.ExecuteCommandInput
	startIn        interactions.StartWorkflowInput
	getActorID     string
	getWorkflowID  string
	continueActor  string
	continueIn     interactions.ContinueWorkflowInput
	cancelActor    string
	cancelIn       interactions.CancelWorkflowInput
	commandCalls   int
	startCalls     int
	getCalls       int
	continueCalls  int
	cancelCalls    int
}

func (service *interactionRouteService) ExecuteCommand(_ context.Context, input interactions.ExecuteCommandInput) (interactions.CommandOutcome, error) {
	service.commandCalls++
	service.commandIn = input
	return service.commandResult, service.commandErr
}

func (service *interactionRouteService) StartWorkflow(_ context.Context, input interactions.StartWorkflowInput) (interactions.Workflow, error) {
	service.startCalls++
	service.startIn = input
	return service.workflowResult, service.startErr
}

func (service *interactionRouteService) GetWorkflow(_ context.Context, actorID, workflowID string) (interactions.Workflow, error) {
	service.getCalls++
	service.getActorID = actorID
	service.getWorkflowID = workflowID
	return service.workflowResult, service.getErr
}

func (service *interactionRouteService) ContinueWorkflow(_ context.Context, actorID string, input interactions.ContinueWorkflowInput) (interactions.WorkflowOutcome, error) {
	service.continueCalls++
	service.continueActor = actorID
	service.continueIn = input
	return service.continueResult, service.continueErr
}

func (service *interactionRouteService) CancelWorkflow(_ context.Context, actorID string, input interactions.CancelWorkflowInput) (interactions.Workflow, error) {
	service.cancelCalls++
	service.cancelActor = actorID
	service.cancelIn = input
	return service.workflowResult, service.cancelErr
}

func interactionRoute(service InteractionService, resolver *interactionRouteResolver, spaceID string) http.Handler {
	return NewRouter(RouterOptions{Gate: gate.New("true"), ActorResolver: resolver, Interactions: service, InteractionSpaceID: spaceID, TrustProxy: true})
}

func TestInteractionCommandRouteUsesTrustedActorSpaceAndMetadata(t *testing.T) {
	service := &interactionRouteService{commandResult: interactions.CommandOutcome{OK: true}}
	resolver := &interactionRouteResolver{actor: &auth.Actor{ID: "usr_owner", Kind: "human"}}
	request := httptest.NewRequest(http.MethodPost, "/api/workspace/interactions/commands", strings.NewReader(`{"actorId":"usr_forged","spaceId":"spc_forged","conversationId":"conv_1","botUserId":"usr_bot","source":"/need","mentionedBotIds":["usr_bot"],"clientInvocationId":"invoke_1"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Request-ID", "interaction-request")
	request.Header.Set("User-Agent", "interaction-route-test")
	response := httptest.NewRecorder()

	interactionRoute(service, resolver, "").ServeHTTP(response, request)

	if response.Code != http.StatusOK || service.commandCalls != 1 {
		t.Fatalf("response = %d calls=%d body=%s", response.Code, service.commandCalls, response.Body.String())
	}
	input := service.commandIn
	if input.ActorID != "usr_owner" || input.SpaceID != auth.DefaultSpaceID || input.ConversationID != "conv_1" || input.BotUserID != "usr_bot" || input.Source != "/need" || input.ClientInvocationID != "invoke_1" {
		t.Fatalf("command input = %#v", input)
	}
	if len(input.MentionedBotIDs) != 1 || input.MentionedBotIDs[0] != "usr_bot" || input.Request.Meta.RequestID != "interaction-request" || input.Request.Meta.UserAgent != "interaction-route-test" {
		t.Fatalf("command metadata = %#v", input)
	}
}

func TestWorkflowStartRouteConvertsMillisecondsAndSupportsConfiguredSpace(t *testing.T) {
	service := &interactionRouteService{workflowResult: interactions.Workflow{ID: "wf_1", Type: "echo.requirement", Version: 2}}
	resolver := &interactionRouteResolver{actor: &auth.Actor{ID: "usr_owner"}}
	request := httptest.NewRequest(http.MethodPost, "/api/workspace/workflows", strings.NewReader(`{"actorId":"usr_forged","conversationId":"conv_1","botUserId":"usr_bot","type":"echo.requirement","version":2,"ttlMs":120000,"clientInvocationId":"workflow-1","input":{"title":"hello"}}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()

	interactionRoute(service, resolver, "spc_workspace").ServeHTTP(response, request)

	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"workflow":{"id":"wf_1"`) {
		t.Fatalf("workflow response = %d %s", response.Code, response.Body.String())
	}
	input := service.startIn
	if input.ActorID != "usr_owner" || input.SpaceID != "spc_workspace" || input.Version != 2 || input.TTL != 120*time.Second || input.ClientInvocationID != "workflow-1" || input.ConversationID != "conv_1" || input.BotUserID != "usr_bot" {
		t.Fatalf("workflow input = %#v", input)
	}
	value, ok := input.Input.(map[string]any)
	if !ok || value["title"] != "hello" {
		t.Fatalf("workflow payload = %#v", input.Input)
	}
}

func TestWorkflowRoutesKeepLegacyResponseShapesAndPathIdentity(t *testing.T) {
	service := &interactionRouteService{
		workflowResult: interactions.Workflow{ID: "wf_1", Status: "cancelled"},
		continueResult: interactions.WorkflowOutcome{Workflow: interactions.Workflow{ID: "wf_1", Revision: 2}, Result: map[string]any{"ok": true}},
	}
	resolver := &interactionRouteResolver{actor: &auth.Actor{ID: "usr_owner"}}
	router := interactionRoute(service, resolver, "spc_default")

	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/workspace/workflows/wf_1", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"workflow":{"id":"wf_1"`) || service.getActorID != "usr_owner" || service.getWorkflowID != "wf_1" {
		t.Fatalf("get response = %d %s input=%#v", response.Code, response.Body.String(), service)
	}

	request := httptest.NewRequest(http.MethodPost, "/api/workspace/workflows/wf_1/continue", strings.NewReader(`{"expectedRevision":1,"input":{"step":"next"}}`))
	request.Header.Set("Content-Type", "application/json")
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), `"workflow":{"workflow":`) || !strings.Contains(response.Body.String(), `"result":{"ok":true}`) {
		t.Fatalf("continue response = %d %s", response.Code, response.Body.String())
	}
	if service.continueActor != "usr_owner" || service.continueIn.WorkflowID != "wf_1" || service.continueIn.ExpectedRevision != 1 {
		t.Fatalf("continue input = %#v", service.continueIn)
	}

	response = httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/workspace/workflows/wf_1/cancel", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"workflow":{"id":"wf_1"`) || service.cancelActor != "usr_owner" || service.cancelIn.WorkflowID != "wf_1" || service.cancelIn.SpaceID != auth.DefaultSpaceID {
		t.Fatalf("cancel response = %d %s input=%#v", response.Code, response.Body.String(), service)
	}
}

func TestInteractionRoutesRejectNonObjectBodies(t *testing.T) {
	for _, body := range []string{"null", "[]", ""} {
		service := &interactionRouteService{}
		resolver := &interactionRouteResolver{actor: &auth.Actor{ID: "usr_owner"}}
		request := httptest.NewRequest(http.MethodPost, "/api/workspace/interactions/commands", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		interactionRoute(service, resolver, "").ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"code":"interaction.invalid_request"`) || service.commandCalls != 0 {
			t.Fatalf("body %q response = %d calls=%d %s", body, response.Code, service.commandCalls, response.Body.String())
		}
	}
}

func TestInteractionErrorPreservesSafeDetailsAndHidesInternalCause(t *testing.T) {
	service := &interactionRouteService{startErr: &interactions.Error{Code: interactions.CodeWorkflowActiveConflict, Message: "当前 Bot 会话已有进行中的引导流程", StatusCode: http.StatusConflict, Details: map[string]any{"activeWorkflowId": "wf_active"}}}
	resolver := &interactionRouteResolver{actor: &auth.Actor{ID: "usr_owner"}}
	router := interactionRoute(service, resolver, "")
	request := httptest.NewRequest(http.MethodPost, "/api/workspace/workflows", strings.NewReader(`{"type":"echo.requirement"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), `"activeWorkflowId":"wf_active"`) || !strings.Contains(response.Body.String(), `"code":"workflow.active_conflict"`) {
		t.Fatalf("domain error = %d %s", response.Code, response.Body.String())
	}

	service.startErr = errors.New("postgres password=secret")
	request = httptest.NewRequest(http.MethodPost, "/api/workspace/workflows", strings.NewReader(`{"type":"echo.requirement"}`))
	request.Header.Set("Content-Type", "application/json")
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusInternalServerError || !strings.Contains(response.Body.String(), `"code":"internal.error"`) || strings.Contains(response.Body.String(), "postgres") || strings.Contains(response.Body.String(), "secret") {
		t.Fatalf("internal error = %d %s", response.Code, response.Body.String())
	}
}

func TestInteractionServiceUnavailablePrecedesAuthentication(t *testing.T) {
	resolver := &interactionRouteResolver{actor: &auth.Actor{ID: "usr_owner"}}
	response := httptest.NewRecorder()
	interactionRoute(nil, resolver, "").ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/workspace/workflows/wf_1", nil))
	if response.Code != http.StatusServiceUnavailable || resolver.calls != 0 || !strings.Contains(response.Body.String(), `"code":"interaction.unavailable"`) {
		t.Fatalf("unavailable response = %d calls=%d body=%s", response.Code, resolver.calls, response.Body.String())
	}
}

func TestInteractionRouteRejectsOversizedBodyBeforeService(t *testing.T) {
	service := &interactionRouteService{}
	resolver := &interactionRouteResolver{actor: &auth.Actor{ID: "usr_owner"}}
	request := httptest.NewRequest(http.MethodPost, "/api/workspace/workflows", strings.NewReader(`{"type":"`+strings.Repeat("A", int(MaxJSONBodyBytes))+`"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	interactionRoute(service, resolver, "").ServeHTTP(response, request)
	if response.Code != http.StatusRequestEntityTooLarge || !strings.Contains(response.Body.String(), `"code":"request.too_large"`) || service.startCalls != 0 {
		t.Fatalf("oversized response = %d calls=%d body=%s", response.Code, service.startCalls, response.Body.String())
	}
}
