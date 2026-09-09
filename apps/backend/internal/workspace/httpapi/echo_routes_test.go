package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/delivery"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/solicitations"
)

func TestEchoRequirementHTTPTranslatesNodeDTOAndSyncsAfterMutation(t *testing.T) {
	requirementsFake := &echoRequirementsFake{
		submit: func(_ context.Context, input requirements.SubmitInput) (*requirements.Requirement, error) {
			if input.ActorID != "user-1" || input.SpaceID != "space-1" {
				t.Errorf("submit identity = %#v/%#v, want user-1/space-1", input.ActorID, input.SpaceID)
			}
			if input.RelatedLink != "https://example.test/help" {
				t.Errorf("related link = %q", input.RelatedLink)
			}
			return &requirements.Requirement{PublicID: "REQ-2026-0001", Title: input.Title}, nil
		},
	}
	deliveryFake := &echoDeliveryFake{}
	handler := newEchoTestRouter(EchoRouteOptions{
		Requirements: requirementsFake, Delivery: deliveryFake, SpaceID: "space-1",
		ActorResolver: echoActorResolver{actor: &auth.Actor{ID: "user-1", Role: "owner"}},
	})

	request := httptest.NewRequest(http.MethodPost, "/echo/requirements", strings.NewReader(`{"type":"requirement","title":"A title","detail":"A detail","scenario":"A scenario","expectedResult":"A result","relatedLink":"https://example.test/help","idempotencyKey":"req-key"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if _, ok := payload["requirement"]; !ok {
		t.Fatalf("response missing requirement: %s", response.Body.String())
	}
	if deliveryFake.requirementPublicID != "REQ-2026-0001" {
		t.Fatalf("delivery public id = %q", deliveryFake.requirementPublicID)
	}
}

func TestEchoRequirementHTTPRejectsNonObjectAndReportsUnavailable(t *testing.T) {
	handler := newEchoTestRouter(EchoRouteOptions{
		Requirements: &echoRequirementsFake{}, SpaceID: "space-1",
		ActorResolver: echoActorResolver{actor: &auth.Actor{ID: "user-1"}},
	})
	request := httptest.NewRequest(http.MethodPost, "/echo/requirements", strings.NewReader(`[]`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	assertEchoError(t, response, http.StatusBadRequest, "echo.body_invalid")

	missing := newEchoTestRouter(EchoRouteOptions{})
	request = httptest.NewRequest(http.MethodGet, "/echo/requirements", nil)
	response = httptest.NewRecorder()
	missing.ServeHTTP(response, request)
	assertEchoError(t, response, http.StatusServiceUnavailable, "echo.unavailable")
}

func TestEchoSolicitationVoteAndRetryUseDeliveryOwner(t *testing.T) {
	solicitationsFake := &echoSolicitationsFake{
		vote: func(_ context.Context, input solicitations.VoteInput) (*solicitations.Solicitation, error) {
			if input.ActorID != "user-1" || input.SpaceID != "space-1" || input.PublicID != "SOL-2026-0001" {
				t.Errorf("vote identity = %#v/%#v/%#v", input.ActorID, input.SpaceID, input.PublicID)
			}
			if len(input.OptionIDs) != 1 || input.OptionIDs[0] != "option-1" || !input.ExpectedRevisionPresent {
				t.Errorf("vote body = %#v", input)
			}
			return &solicitations.Solicitation{PublicID: input.PublicID}, nil
		},
	}
	deliveryFake := &echoDeliveryFake{}
	handler := newEchoTestRouter(EchoRouteOptions{
		Solicitations: solicitationsFake, Delivery: deliveryFake, SpaceID: "space-1",
		ActorResolver: echoActorResolver{actor: &auth.Actor{ID: "user-1", Role: "member"}},
	})

	request := httptest.NewRequest(http.MethodPost, "/echo/solicitations/SOL-2026-0001/vote", strings.NewReader(`{"optionIds":["option-1"],"expectedRevision":3,"idempotencyKey":"vote-key"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("vote status = %d, body = %s", response.Code, response.Body.String())
	}
	if deliveryFake.solicitationCalls != 1 || deliveryFake.lastForce {
		t.Fatalf("vote delivery calls = %d force = %v", deliveryFake.solicitationCalls, deliveryFake.lastForce)
	}

	request = httptest.NewRequest(http.MethodPost, "/echo/solicitations/SOL-2026-0001/deliveries/retry", nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("retry status = %d, body = %s", response.Code, response.Body.String())
	}
	if deliveryFake.solicitationCalls != 2 || !deliveryFake.lastForce {
		t.Fatalf("retry delivery calls = %d force = %v", deliveryFake.solicitationCalls, deliveryFake.lastForce)
	}
}

func TestEchoSolicitationListPreservesLimitPresence(t *testing.T) {
	fake := &echoSolicitationsFake{
		list: func(_ context.Context, input solicitations.ListInput) ([]solicitations.Solicitation, error) {
			if input.Status != "open" || input.Limit != 4 || !input.LimitPresent {
				t.Errorf("list query = %#v", input)
			}
			return []solicitations.Solicitation{{PublicID: "SOL-2026-0001"}}, nil
		},
	}
	handler := newEchoTestRouter(EchoRouteOptions{
		Solicitations: fake, SpaceID: "space-1",
		ActorResolver: echoActorResolver{actor: &auth.Actor{ID: "user-1"}},
	})
	request := httptest.NewRequest(http.MethodGet, "/echo/solicitations?status=open&limit=4", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
}

func newEchoTestRouter(options EchoRouteOptions) http.Handler {
	router := chi.NewRouter()
	RegisterEchoRoutes(router, options)
	return router
}

func assertEchoError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("status = %d, body = %s, want %d", response.Code, response.Body.String(), status)
	}
	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if payload.Error.Code != code {
		t.Fatalf("error code = %q, body = %s, want %q", payload.Error.Code, response.Body.String(), code)
	}
}

type echoActorResolver struct {
	actor *auth.Actor
	err   error
}

func (r echoActorResolver) ResolveActor(context.Context, *http.Request) (*auth.Actor, error) {
	return r.actor, r.err
}

type echoDeliveryFake struct {
	requirementPublicID string
	solicitationCalls   int
	lastForce           bool
}

func (d *echoDeliveryFake) SyncRequirement(_ context.Context, input delivery.SyncInput) (delivery.DeliverySummary, error) {
	d.requirementPublicID = input.PublicID
	return delivery.DeliverySummary{Type: "requirement", Key: input.PublicID}, nil
}

func (d *echoDeliveryFake) SyncSolicitation(_ context.Context, input delivery.SyncInput) (delivery.DeliverySummary, error) {
	d.solicitationCalls++
	d.lastForce = input.Force
	return delivery.DeliverySummary{Type: "solicitation", Key: input.PublicID}, nil
}

type echoRequirementsFake struct {
	submit func(context.Context, requirements.SubmitInput) (*requirements.Requirement, error)
}

func (f *echoRequirementsFake) Submit(ctx context.Context, input requirements.SubmitInput) (*requirements.Requirement, error) {
	if f.submit != nil {
		return f.submit(ctx, input)
	}
	return &requirements.Requirement{PublicID: "REQ-2026-0001"}, nil
}

func (*echoRequirementsFake) List(context.Context, requirements.ListInput) ([]requirements.Requirement, error) {
	return []requirements.Requirement{}, nil
}

func (*echoRequirementsFake) Stats(context.Context, requirements.StatsInput) (requirements.RequirementStats, error) {
	return requirements.RequirementStats{}, nil
}

func (*echoRequirementsFake) Get(context.Context, requirements.GetInput) (*requirements.Requirement, error) {
	return &requirements.Requirement{PublicID: "REQ-2026-0001"}, nil
}

func (*echoRequirementsFake) History(context.Context, requirements.HistoryInput) ([]requirements.RequirementHistory, error) {
	return []requirements.RequirementHistory{}, nil
}

func (*echoRequirementsFake) Transition(context.Context, requirements.TransitionInput) (*requirements.Requirement, error) {
	return &requirements.Requirement{PublicID: "REQ-2026-0001"}, nil
}

type echoSolicitationsFake struct {
	create func(context.Context, solicitations.CreateInput) (*solicitations.Solicitation, error)
	list   func(context.Context, solicitations.ListInput) ([]solicitations.Solicitation, error)
	vote   func(context.Context, solicitations.VoteInput) (*solicitations.Solicitation, error)
}

func (f *echoSolicitationsFake) Create(ctx context.Context, input solicitations.CreateInput) (*solicitations.Solicitation, error) {
	if f.create != nil {
		return f.create(ctx, input)
	}
	return &solicitations.Solicitation{PublicID: "SOL-2026-0001"}, nil
}

func (f *echoSolicitationsFake) List(ctx context.Context, input solicitations.ListInput) ([]solicitations.Solicitation, error) {
	if f.list != nil {
		return f.list(ctx, input)
	}
	return []solicitations.Solicitation{}, nil
}

func (*echoSolicitationsFake) Get(context.Context, solicitations.GetInput) (*solicitations.Solicitation, error) {
	return &solicitations.Solicitation{PublicID: "SOL-2026-0001"}, nil
}

func (*echoSolicitationsFake) Publish(context.Context, solicitations.TransitionInput) (*solicitations.Solicitation, error) {
	return &solicitations.Solicitation{PublicID: "SOL-2026-0001"}, nil
}

func (*echoSolicitationsFake) Close(context.Context, solicitations.TransitionInput) (*solicitations.Solicitation, error) {
	return &solicitations.Solicitation{PublicID: "SOL-2026-0001"}, nil
}

func (*echoSolicitationsFake) Withdraw(context.Context, solicitations.TransitionInput) (*solicitations.Solicitation, error) {
	return &solicitations.Solicitation{PublicID: "SOL-2026-0001"}, nil
}

func (f *echoSolicitationsFake) Vote(ctx context.Context, input solicitations.VoteInput) (*solicitations.Solicitation, error) {
	if f.vote != nil {
		return f.vote(ctx, input)
	}
	return &solicitations.Solicitation{PublicID: input.PublicID}, nil
}

func (*echoSolicitationsFake) ListVotes(context.Context, solicitations.VotesInput) ([]solicitations.SolicitationVote, error) {
	return []solicitations.SolicitationVote{}, nil
}

func (*echoSolicitationsFake) ListDeliveries(context.Context, solicitations.DeliveriesInput) ([]solicitations.SolicitationDelivery, error) {
	return []solicitations.SolicitationDelivery{}, nil
}
