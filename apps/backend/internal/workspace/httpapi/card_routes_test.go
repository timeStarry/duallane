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
	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
)

type cardRouteResolver struct {
	actor *auth.Actor
	calls int
}

func (resolver *cardRouteResolver) ResolveActor(context.Context, *http.Request) (*auth.Actor, error) {
	resolver.calls++
	return resolver.actor, nil
}

type cardRouteService struct {
	resolution  cards.Resolution
	action      cards.ActionOutcome
	resolveErr  error
	actionErr   error
	resolveIn   cards.Request
	resolveID   string
	resolveCard string
	actionIn    cards.ActionInput
	resolveCall int
	actionCall  int
}

func (service *cardRouteService) ResolveCard(_ context.Context, actorID, cardID string, request cards.Request) (cards.Resolution, error) {
	service.resolveCall++
	service.resolveID = actorID
	service.resolveCard = cardID
	service.resolveIn = request
	return service.resolution, service.resolveErr
}

func (service *cardRouteService) ExecuteAction(_ context.Context, input cards.ActionInput) (cards.ActionOutcome, error) {
	service.actionCall++
	service.actionIn = input
	return service.action, service.actionErr
}

func cardRoute(service CardService, resolver *cardRouteResolver) http.Handler {
	return NewRouter(RouterOptions{Gate: gate.New("true"), ActorResolver: resolver, Cards: service, TrustProxy: true})
}

func TestCardResolveRouteProjectsActorAndSafeRequestMetadata(t *testing.T) {
	service := &cardRouteService{resolution: cards.Resolution{
		Type: "card_fallback", Reason: "card.unknown_version",
		Block: cards.CardBlock{Type: "card", CardID: "card_1", CardType: "future.poll", SchemaVersion: 1},
	}}
	resolver := &cardRouteResolver{actor: &auth.Actor{ID: "usr_member", Kind: "human"}}
	request := httptest.NewRequest(http.MethodGet, "/api/workspace/cards/card_1", nil)
	request.RemoteAddr = "10.0.0.8:1234"
	request.Header.Set("X-Request-ID", "card-request-1")
	request.Header.Set("X-Forwarded-For", "203.0.113.8, 10.0.0.1")
	request.Header.Set("User-Agent", "card-route-test")
	response := httptest.NewRecorder()

	cardRoute(service, resolver).ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		Card cards.Resolution `json:"card"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Card.Type != "card_fallback" || service.resolveID != "usr_member" || service.resolveCard != "card_1" {
		t.Fatalf("projection = %#v input=%#v", payload.Card, service)
	}
	if service.resolveIn.Meta.RequestID != "card-request-1" || service.resolveIn.Meta.IPAddress != "203.0.113.8" || service.resolveIn.Meta.UserAgent != "card-route-test" {
		t.Fatalf("request metadata = %#v", service.resolveIn.Meta)
	}
}

func TestCardActionRouteIgnoresForgedIdentityAndDefaultsInput(t *testing.T) {
	service := &cardRouteService{action: cards.ActionOutcome{OK: true, Revision: 4}}
	resolver := &cardRouteResolver{actor: &auth.Actor{ID: "usr_member", Kind: "human"}}
	request := httptest.NewRequest(http.MethodPost, "/api/workspace/cards/card_1/actions", strings.NewReader(`{"actorId":"usr_forged","actionId":"vote","expectedRevision":3,"clientActionId":"client-action-1","input":{"optionId":"opt_1"}}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Request-ID", "card-action-request")
	response := httptest.NewRecorder()

	cardRoute(service, resolver).ServeHTTP(response, request)

	if response.Code != http.StatusOK || service.actionCall != 1 {
		t.Fatalf("action response = %d calls=%d body=%s", response.Code, service.actionCall, response.Body.String())
	}
	if service.actionIn.ActorID != "usr_member" || service.actionIn.CardID != "card_1" || service.actionIn.ActionID != "vote" || service.actionIn.ClientActionID != "client-action-1" || service.actionIn.ExpectedRevision != 3 {
		t.Fatalf("action input = %#v", service.actionIn)
	}
	input, ok := service.actionIn.Input.(map[string]any)
	if !ok || input["optionId"] != "opt_1" || service.actionIn.Meta.RequestID != "card-action-request" {
		t.Fatalf("action payload/meta = %#v / %#v", service.actionIn.Input, service.actionIn.Meta)
	}
}

func TestCardActionRouteDefaultsMissingInputToObject(t *testing.T) {
	service := &cardRouteService{}
	resolver := &cardRouteResolver{actor: &auth.Actor{ID: "usr_member"}}
	request := httptest.NewRequest(http.MethodPost, "/api/workspace/cards/card_1/actions", strings.NewReader(`{"actionId":"vote","expectedRevision":1,"clientActionId":"client-action-1"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()

	cardRoute(service, resolver).ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if input, ok := service.actionIn.Input.(map[string]any); !ok || len(input) != 0 {
		t.Fatalf("default action input = %#v", service.actionIn.Input)
	}
}

func TestCardRoutesRejectNonObjectAndOversizedBodies(t *testing.T) {
	for name, body := range map[string]string{
		"null":  "null",
		"array": "[]",
		"empty": "",
		"large": `{"actionId":"` + strings.Repeat("A", int(MaxJSONBodyBytes)) + `"}`,
	} {
		t.Run(name, func(t *testing.T) {
			service := &cardRouteService{}
			resolver := &cardRouteResolver{actor: &auth.Actor{ID: "usr_member"}}
			request := httptest.NewRequest(http.MethodPost, "/api/workspace/cards/card_1/actions", strings.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			cardRoute(service, resolver).ServeHTTP(response, request)
			if name == "large" {
				if response.Code != http.StatusRequestEntityTooLarge || !strings.Contains(response.Body.String(), `"code":"request.too_large"`) {
					t.Fatalf("large response = %d %s", response.Code, response.Body.String())
				}
			} else if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"code":"card.invalid_request"`) {
				t.Fatalf("invalid response = %d %s", response.Code, response.Body.String())
			}
			if service.actionCall != 0 {
				t.Fatalf("invalid body reached service: %d", service.actionCall)
			}
		})
	}
}

func TestCardRoutesPreserveDomainStatusAndHideInternalCause(t *testing.T) {
	service := &cardRouteService{resolveErr: cards.NewError(cards.CodeCardNotFound, cards.MessageCardNotFound, http.StatusNotFound)}
	resolver := &cardRouteResolver{actor: &auth.Actor{ID: "usr_member"}}
	router := cardRoute(service, resolver)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/workspace/cards/missing", nil))
	if response.Code != http.StatusNotFound || !strings.Contains(response.Body.String(), `"code":"card.not_found"`) || strings.Contains(response.Body.String(), "Cause") {
		t.Fatalf("domain error = %d %s", response.Code, response.Body.String())
	}

	service.resolveErr = errors.New("postgres password=secret")
	response = httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/workspace/cards/missing", nil))
	if response.Code != http.StatusInternalServerError || !strings.Contains(response.Body.String(), `"code":"internal.error"`) || strings.Contains(response.Body.String(), "postgres") || strings.Contains(response.Body.String(), "secret") {
		t.Fatalf("internal error = %d %s", response.Code, response.Body.String())
	}
}

func TestCardServiceUnavailablePrecedesAuthentication(t *testing.T) {
	resolver := &cardRouteResolver{actor: &auth.Actor{ID: "usr_member"}}
	response := httptest.NewRecorder()
	cardRoute(nil, resolver).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/workspace/cards/card_1", nil))
	if response.Code != http.StatusServiceUnavailable || resolver.calls != 0 || !strings.Contains(response.Body.String(), `"code":"card.unavailable"`) {
		t.Fatalf("unavailable response = %d calls=%d body=%s", response.Code, resolver.calls, response.Body.String())
	}
}
