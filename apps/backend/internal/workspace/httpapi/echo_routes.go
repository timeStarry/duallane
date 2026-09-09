package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/delivery"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/solicitations"
)

// EchoRequirementsService is the HTTP-facing requirements capability. The
// service owns authorization, idempotency, audit, and event writes; these
// routes only translate the Node-compatible transport DTOs.
type EchoRequirementsService interface {
	Submit(context.Context, requirements.SubmitInput) (*requirements.Requirement, error)
	List(context.Context, requirements.ListInput) ([]requirements.Requirement, error)
	Stats(context.Context, requirements.StatsInput) (requirements.RequirementStats, error)
	Get(context.Context, requirements.GetInput) (*requirements.Requirement, error)
	History(context.Context, requirements.HistoryInput) ([]requirements.RequirementHistory, error)
	Transition(context.Context, requirements.TransitionInput) (*requirements.Requirement, error)
}

// EchoRequirementPageService is implemented by the current Go service. It is
// optional so a parent can temporarily compose a read-only adapter without
// changing the ordinary list response contract.
type EchoRequirementPageService interface {
	ListPage(context.Context, requirements.ListInput) (requirements.RequirementPage, error)
}

// EchoSolicitationsService is the HTTP-facing solicitation capability. It
// deliberately exposes only delivery projections; delivery state mutation is
// owned by Echo delivery.
type EchoSolicitationsService interface {
	Create(context.Context, solicitations.CreateInput) (*solicitations.Solicitation, error)
	List(context.Context, solicitations.ListInput) ([]solicitations.Solicitation, error)
	Get(context.Context, solicitations.GetInput) (*solicitations.Solicitation, error)
	Publish(context.Context, solicitations.TransitionInput) (*solicitations.Solicitation, error)
	Close(context.Context, solicitations.TransitionInput) (*solicitations.Solicitation, error)
	Withdraw(context.Context, solicitations.TransitionInput) (*solicitations.Solicitation, error)
	Vote(context.Context, solicitations.VoteInput) (*solicitations.Solicitation, error)
	ListVotes(context.Context, solicitations.VotesInput) ([]solicitations.SolicitationVote, error)
	ListDeliveries(context.Context, solicitations.DeliveriesInput) ([]solicitations.SolicitationDelivery, error)
}

// EchoDeliveryHooks is a narrow, parent-injected handoff to the unique Echo
// delivery owner. No route calls a solicitation delivery-state mutator.
type EchoDeliveryHooks interface {
	SyncRequirement(context.Context, delivery.SyncInput) (delivery.DeliverySummary, error)
	SyncSolicitation(context.Context, delivery.SyncInput) (delivery.DeliverySummary, error)
}

// EchoRouteOptions contains the construction seam for the Echo HTTP surface.
// RegisterEchoRoutes mounts paths relative to /api/workspace; the parent must
// call it inside the existing exact Workspace feature-gate middleware.
type EchoRouteOptions struct {
	Requirements  EchoRequirementsService
	Solicitations EchoSolicitationsService
	Delivery      EchoDeliveryHooks
	SpaceID       string
	ActorResolver ActorResolver
	TrustProxy    bool
}

// RegisterEchoRoutes mounts the Node-compatible requirements and solicitation
// endpoints relative to /api/workspace. It does not add a feature gate or
// modify the shared router; composition owns that boundary.
func RegisterEchoRoutes(router chi.Router, options EchoRouteOptions) {
	if router == nil {
		return
	}

	router.Post("/echo/requirements", func(response http.ResponseWriter, request *http.Request) {
		if options.Requirements == nil {
			writeEchoUnavailable(response)
			return
		}
		actor, ok := resolveEchoActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		fields, err := decodeEchoObject(response, request, true)
		if err != nil {
			writeEchoError(response, err)
			return
		}
		var body echoRequirementSubmitBody
		if err := decodeEchoFields(fields, &body); err != nil {
			writeEchoError(response, err)
			return
		}
		result, err := options.Requirements.Submit(request.Context(), requirements.SubmitInput{
			ActorID: actor.ID, SpaceID: options.SpaceID,
			Type: body.Type, Title: body.Title, Detail: body.Detail,
			Scenario: body.Scenario, ExpectedResult: body.ExpectedResult,
			RelatedLink: body.RelatedLink, IdempotencyKey: body.IdempotencyKey,
			Meta: auth.RequestMetaFromRequest(request, options.TrustProxy),
		})
		if err != nil {
			writeEchoError(response, err)
			return
		}
		syncEchoRequirement(options, request, result)
		writeJSON(response, http.StatusCreated, map[string]any{"requirement": result})
	})

	router.Get("/echo/requirements", func(response http.ResponseWriter, request *http.Request) {
		if options.Requirements == nil {
			writeEchoUnavailable(response)
			return
		}
		actor, ok := resolveEchoActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		query := request.URL.Query()
		limit, _, err := echoOptionalInt(query.Get("limit"), query.Has("limit"))
		if err != nil {
			writeEchoError(response, requirements.NewError(requirements.CodeLimitInvalid, "列表数量无效", http.StatusBadRequest))
			return
		}
		offset, _, err := echoOptionalInt(query.Get("offset"), query.Has("offset"))
		if err != nil {
			writeEchoError(response, requirements.NewError(requirements.CodeOffsetInvalid, "列表偏移无效", http.StatusBadRequest))
			return
		}
		input := requirements.ListInput{
			ActorID: actor.ID, SpaceID: options.SpaceID,
			State: query.Get("state"), Phase: query.Get("phase"),
			Status: query.Get("status"), ArchiveOutcome: query.Get("archiveOutcome"),
			Type: query.Get("type"), SubmitterUserID: query.Get("submitterUserId"),
			CreatedFrom: query.Get("createdFrom"), CreatedTo: query.Get("createdTo"),
			Limit: limit, Offset: offset,
			Meta: auth.RequestMetaFromRequest(request, options.TrustProxy),
		}
		if pageService, ok := options.Requirements.(EchoRequirementPageService); ok {
			page, err := pageService.ListPage(request.Context(), input)
			if err != nil {
				writeEchoError(response, err)
				return
			}
			writeJSON(response, http.StatusOK, map[string]any{
				"requirements": page.Items, "total": page.Total, "pageInfo": page.PageInfo,
			})
			return
		}
		items, err := options.Requirements.List(request.Context(), input)
		if err != nil {
			writeEchoError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"requirements": items})
	})

	router.Get("/echo/requirements/stats", func(response http.ResponseWriter, request *http.Request) {
		if options.Requirements == nil {
			writeEchoUnavailable(response)
			return
		}
		actor, ok := resolveEchoActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		stats, err := options.Requirements.Stats(request.Context(), requirements.StatsInput{
			ActorID: actor.ID, SpaceID: options.SpaceID,
			Meta: auth.RequestMetaFromRequest(request, options.TrustProxy),
		})
		if err != nil {
			writeEchoError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"stats": stats})
	})

	router.Get("/echo/requirements/{publicId}/history", func(response http.ResponseWriter, request *http.Request) {
		if options.Requirements == nil {
			writeEchoUnavailable(response)
			return
		}
		actor, ok := resolveEchoActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		history, err := options.Requirements.History(request.Context(), requirements.HistoryInput{
			ActorID: actor.ID, SpaceID: options.SpaceID, PublicID: chi.URLParam(request, "publicId"),
			Meta: auth.RequestMetaFromRequest(request, options.TrustProxy),
		})
		if err != nil {
			writeEchoError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"history": history})
	})

	router.Get("/echo/requirements/{publicId}", func(response http.ResponseWriter, request *http.Request) {
		if options.Requirements == nil {
			writeEchoUnavailable(response)
			return
		}
		actor, ok := resolveEchoActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		result, err := options.Requirements.Get(request.Context(), requirements.GetInput{
			ActorID: actor.ID, SpaceID: options.SpaceID, PublicID: chi.URLParam(request, "publicId"),
			Meta: auth.RequestMetaFromRequest(request, options.TrustProxy),
		})
		if err != nil {
			writeEchoError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"requirement": result})
	})

	router.Post("/echo/requirements/{publicId}/transition", func(response http.ResponseWriter, request *http.Request) {
		if options.Requirements == nil {
			writeEchoUnavailable(response)
			return
		}
		actor, ok := resolveEchoActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		fields, err := decodeEchoObject(response, request, true)
		if err != nil {
			writeEchoError(response, err)
			return
		}
		var body echoRequirementTransitionBody
		if err := decodeEchoFields(fields, &body); err != nil {
			writeEchoError(response, err)
			return
		}
		input := requirements.TransitionInput{
			ActorID: actor.ID, SpaceID: options.SpaceID, PublicID: chi.URLParam(request, "publicId"),
			ToState: body.ToState, State: body.State, ToPhase: body.ToPhase, Phase: body.Phase,
			ToStatus: body.ToStatus, Status: body.Status, ArchiveOutcome: body.ArchiveOutcome,
			DuplicateOfPublicID: body.DuplicateOfPublicID, Response: body.Response,
			ExpectedRevision: body.ExpectedRevision, IdempotencyKey: body.IdempotencyKey,
			ResponseSet:            echoFieldPresent(fields, "response"),
			DuplicateOfPublicIDSet: echoFieldPresent(fields, "duplicateOfPublicId"),
			Meta:                   auth.RequestMetaFromRequest(request, options.TrustProxy),
		}
		result, err := options.Requirements.Transition(request.Context(), input)
		if err != nil {
			writeEchoError(response, err)
			return
		}
		syncEchoRequirement(options, request, result)
		writeJSON(response, http.StatusOK, map[string]any{"requirement": result})
	})

	router.Post("/echo/solicitations", func(response http.ResponseWriter, request *http.Request) {
		if options.Solicitations == nil {
			writeEchoUnavailable(response)
			return
		}
		actor, ok := resolveEchoActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		fields, err := decodeEchoObject(response, request, true)
		if err != nil {
			writeEchoError(response, err)
			return
		}
		var body echoSolicitationCreateBody
		if err := decodeEchoFields(fields, &body); err != nil {
			writeEchoError(response, err)
			return
		}
		result, err := options.Solicitations.Create(request.Context(), solicitations.CreateInput{
			ActorID: actor.ID, SpaceID: options.SpaceID, Title: body.Title,
			Description: body.Description, Detail: body.Detail, Question: body.Question,
			Options: body.Options, ChoiceMode: body.ChoiceMode, MinSelections: body.MinSelections,
			MaxSelections: body.MaxSelections, AllowVoteChange: body.AllowVoteChange,
			ResultVisibility: body.ResultVisibility, DeliveryPolicy: body.DeliveryPolicy,
			Deadline: body.Deadline, IdempotencyKey: body.IdempotencyKey,
			Presence: solicitations.CreateInputPresence{
				Description: echoFieldPresent(fields, "description"), Detail: echoFieldPresent(fields, "detail"),
				ChoiceMode: echoFieldPresent(fields, "choiceMode"), MinSelections: echoFieldPresent(fields, "minSelections"),
				MaxSelections: echoFieldPresent(fields, "maxSelections"), ResultVisibility: echoFieldPresent(fields, "resultVisibility"),
				DeliveryPolicy: echoFieldPresent(fields, "deliveryPolicy"), Deadline: echoFieldPresent(fields, "deadline"),
			},
			Meta: auth.RequestMetaFromRequest(request, options.TrustProxy),
		})
		if err != nil {
			writeEchoError(response, err)
			return
		}
		writeJSON(response, http.StatusCreated, map[string]any{"solicitation": result})
	})

	router.Get("/echo/solicitations", func(response http.ResponseWriter, request *http.Request) {
		if options.Solicitations == nil {
			writeEchoUnavailable(response)
			return
		}
		actor, ok := resolveEchoActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		query := request.URL.Query()
		limit, present, err := echoOptionalInt(query.Get("limit"), query.Has("limit"))
		if err != nil {
			writeEchoError(response, err)
			return
		}
		items, err := options.Solicitations.List(request.Context(), solicitations.ListInput{
			ActorID: actor.ID, SpaceID: options.SpaceID, Status: query.Get("status"),
			Limit: limit, LimitPresent: present,
			Meta: auth.RequestMetaFromRequest(request, options.TrustProxy),
		})
		if err != nil {
			writeEchoError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"solicitations": items})
	})

	router.Get("/echo/solicitations/{publicId}", func(response http.ResponseWriter, request *http.Request) {
		if options.Solicitations == nil {
			writeEchoUnavailable(response)
			return
		}
		actor, ok := resolveEchoActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		result, err := options.Solicitations.Get(request.Context(), solicitations.GetInput{
			ActorID: actor.ID, SpaceID: options.SpaceID, PublicID: chi.URLParam(request, "publicId"),
			Meta: auth.RequestMetaFromRequest(request, options.TrustProxy),
		})
		if err != nil {
			writeEchoError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"solicitation": result})
	})

	router.Post("/echo/solicitations/{publicId}/publish", echoSolicitationTransitionHandler(options, "publish"))
	router.Post("/echo/solicitations/{publicId}/close", echoSolicitationTransitionHandler(options, "close"))
	router.Post("/echo/solicitations/{publicId}/withdraw", echoSolicitationTransitionHandler(options, "withdraw"))

	router.Post("/echo/solicitations/{publicId}/vote", func(response http.ResponseWriter, request *http.Request) {
		if options.Solicitations == nil {
			writeEchoUnavailable(response)
			return
		}
		actor, ok := resolveEchoActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		fields, err := decodeEchoObject(response, request, false)
		if err != nil {
			writeEchoError(response, err)
			return
		}
		var body echoSolicitationVoteBody
		if err := decodeEchoFields(fields, &body); err != nil {
			writeEchoError(response, err)
			return
		}
		result, err := options.Solicitations.Vote(request.Context(), solicitations.VoteInput{
			ActorID: actor.ID, SpaceID: options.SpaceID, PublicID: chi.URLParam(request, "publicId"),
			OptionIDs: body.OptionIDs, SelectedOptionIDs: body.SelectedOptionIDs,
			ExpectedRevision: body.ExpectedRevision, ExpectedRevisionPresent: echoFieldPresent(fields, "expectedRevision"),
			IdempotencyKey: body.IdempotencyKey,
			ConversationID: body.ConversationID, Meta: auth.RequestMetaFromRequest(request, options.TrustProxy),
		})
		if err != nil {
			writeEchoError(response, err)
			return
		}
		syncEchoSolicitation(options, request, result, false)
		writeJSON(response, http.StatusOK, map[string]any{"solicitation": result})
	})

	router.Get("/echo/solicitations/{publicId}/votes", func(response http.ResponseWriter, request *http.Request) {
		if options.Solicitations == nil {
			writeEchoUnavailable(response)
			return
		}
		actor, ok := resolveEchoActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		votes, err := options.Solicitations.ListVotes(request.Context(), solicitations.VotesInput{
			ActorID: actor.ID, SpaceID: options.SpaceID, PublicID: chi.URLParam(request, "publicId"),
			Meta: auth.RequestMetaFromRequest(request, options.TrustProxy),
		})
		if err != nil {
			writeEchoError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"votes": votes})
	})

	router.Get("/echo/solicitations/{publicId}/deliveries", func(response http.ResponseWriter, request *http.Request) {
		if options.Solicitations == nil {
			writeEchoUnavailable(response)
			return
		}
		actor, ok := resolveEchoActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		rows, err := options.Solicitations.ListDeliveries(request.Context(), solicitations.DeliveriesInput{
			ActorID: actor.ID, SpaceID: options.SpaceID, PublicID: chi.URLParam(request, "publicId"),
			Meta: auth.RequestMetaFromRequest(request, options.TrustProxy),
		})
		if err != nil {
			writeEchoError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"deliveries": rows})
	})

	router.Post("/echo/solicitations/{publicId}/deliveries/retry", func(response http.ResponseWriter, request *http.Request) {
		if options.Solicitations == nil {
			writeEchoUnavailable(response)
			return
		}
		actor, ok := resolveEchoActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		publicID := chi.URLParam(request, "publicId")
		if _, err := options.Solicitations.ListDeliveries(request.Context(), solicitations.DeliveriesInput{
			ActorID: actor.ID, SpaceID: options.SpaceID, PublicID: publicID,
			Meta: auth.RequestMetaFromRequest(request, options.TrustProxy),
		}); err != nil {
			writeEchoError(response, err)
			return
		}
		deliveryResult := syncEchoSolicitation(options, request, &solicitations.Solicitation{PublicID: publicID}, true)
		writeJSON(response, http.StatusOK, map[string]any{"delivery": deliveryResult})
	})
}

func echoSolicitationTransitionHandler(options EchoRouteOptions, operation string) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if options.Solicitations == nil {
			writeEchoUnavailable(response)
			return
		}
		actor, ok := resolveEchoActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		fields, err := decodeEchoObject(response, request, false)
		if err != nil {
			writeEchoError(response, err)
			return
		}
		var body echoSolicitationActionBody
		if err := decodeEchoFields(fields, &body); err != nil {
			writeEchoError(response, err)
			return
		}
		input := solicitations.TransitionInput{
			ActorID: actor.ID, SpaceID: options.SpaceID, PublicID: chi.URLParam(request, "publicId"),
			ExpectedRevision: body.ExpectedRevision, ExpectedRevisionPresent: echoFieldPresent(fields, "expectedRevision"),
			IdempotencyKey: body.IdempotencyKey, ConversationID: body.ConversationID,
			Meta: auth.RequestMetaFromRequest(request, options.TrustProxy),
		}
		var result *solicitations.Solicitation
		switch operation {
		case "publish":
			result, err = options.Solicitations.Publish(request.Context(), input)
		case "close":
			result, err = options.Solicitations.Close(request.Context(), input)
		case "withdraw":
			result, err = options.Solicitations.Withdraw(request.Context(), input)
		default:
			err = errors.New("unknown Echo solicitation operation")
		}
		if err != nil {
			writeEchoError(response, err)
			return
		}
		syncEchoSolicitation(options, request, result, false)
		writeJSON(response, http.StatusOK, map[string]any{"solicitation": result})
	}
}

type echoRequirementSubmitBody struct {
	Type           string `json:"type"`
	Title          string `json:"title"`
	Detail         string `json:"detail"`
	Scenario       string `json:"scenario"`
	ExpectedResult string `json:"expectedResult"`
	RelatedLink    string `json:"relatedLink"`
	IdempotencyKey string `json:"idempotencyKey"`
}

type echoRequirementTransitionBody struct {
	ToState             string `json:"toState"`
	State               string `json:"state"`
	ToPhase             string `json:"toPhase"`
	Phase               string `json:"phase"`
	ToStatus            string `json:"toStatus"`
	Status              string `json:"status"`
	ArchiveOutcome      string `json:"archiveOutcome"`
	DuplicateOfPublicID string `json:"duplicateOfPublicId"`
	Response            string `json:"response"`
	ExpectedRevision    int64  `json:"expectedRevision"`
	IdempotencyKey      string `json:"idempotencyKey"`
}

type echoSolicitationCreateBody struct {
	Title            string   `json:"title"`
	Description      string   `json:"description"`
	Detail           string   `json:"detail"`
	Question         string   `json:"question"`
	Options          []string `json:"options"`
	ChoiceMode       string   `json:"choiceMode"`
	MinSelections    int      `json:"minSelections"`
	MaxSelections    int      `json:"maxSelections"`
	AllowVoteChange  *bool    `json:"allowVoteChange"`
	ResultVisibility string   `json:"resultVisibility"`
	DeliveryPolicy   string   `json:"deliveryPolicy"`
	Deadline         string   `json:"deadline"`
	IdempotencyKey   string   `json:"idempotencyKey"`
}

type echoSolicitationActionBody struct {
	ExpectedRevision int64  `json:"expectedRevision"`
	IdempotencyKey   string `json:"idempotencyKey"`
	ConversationID   string `json:"conversationId"`
}

type echoSolicitationVoteBody struct {
	OptionIDs         []string `json:"optionIds"`
	SelectedOptionIDs []string `json:"selectedOptionIds"`
	ExpectedRevision  int64    `json:"expectedRevision"`
	IdempotencyKey    string   `json:"idempotencyKey"`
	ConversationID    string   `json:"conversationId"`
}

func resolveEchoActor(response http.ResponseWriter, request *http.Request, resolver ActorResolver) (*auth.Actor, bool) {
	return resolveActor(response, request, resolver)
}

func writeEchoUnavailable(response http.ResponseWriter) {
	writeJSON(response, http.StatusServiceUnavailable, map[string]any{
		"error": &publicError{Code: "echo.unavailable", Message: "回声服务暂不可用", StatusCode: http.StatusServiceUnavailable},
	})
}

func decodeEchoObject(response http.ResponseWriter, request *http.Request, required bool) (map[string]json.RawMessage, error) {
	var value any
	if err := decodeJSON(response, request, &value); err != nil {
		return nil, err
	}
	if value == nil {
		if required {
			return nil, echoBodyInvalid()
		}
		return map[string]json.RawMessage{}, nil
	}
	object, ok := value.(map[string]any)
	if !ok {
		if required {
			return nil, echoBodyInvalid()
		}
		return map[string]json.RawMessage{}, nil
	}
	encoded, err := json.Marshal(object)
	if err != nil {
		return nil, echoBodyInvalid()
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil || fields == nil {
		return nil, echoBodyInvalid()
	}
	return fields, nil
}

func decodeEchoFields(fields map[string]json.RawMessage, target any) error {
	encoded, err := json.Marshal(fields)
	if err != nil || json.Unmarshal(encoded, target) != nil {
		return echoBodyInvalid()
	}
	return nil
}

func echoFieldPresent(fields map[string]json.RawMessage, name string) bool {
	value, ok := fields[name]
	return ok && strings.TrimSpace(string(value)) != "null"
}

func echoOptionalInt(value string, present bool) (int, bool, error) {
	if !present || strings.TrimSpace(value) == "" {
		return 0, false, nil
	}
	parsed, err := json.Number(value).Int64()
	if err != nil {
		return 0, true, solicitations.NewError(solicitations.CodeLimitInvalid, solicitations.MessageLimitInvalid, http.StatusBadRequest)
	}
	if int64(int(parsed)) != parsed {
		return 0, true, solicitations.NewError(solicitations.CodeLimitInvalid, solicitations.MessageLimitInvalid, http.StatusBadRequest)
	}
	return int(parsed), true, nil
}

func echoBodyInvalid() error {
	return requirements.NewError("echo.body_invalid", "请求内容无效", http.StatusBadRequest)
}

func syncEchoRequirement(options EchoRouteOptions, request *http.Request, result *requirements.Requirement) {
	if options.Delivery == nil || result == nil {
		return
	}
	_, _ = options.Delivery.SyncRequirement(request.Context(), delivery.SyncInput{
		SpaceID: options.SpaceID, PublicID: result.PublicID,
		Meta: auth.RequestMetaFromRequest(request, options.TrustProxy),
	})
}

func syncEchoSolicitation(options EchoRouteOptions, request *http.Request, result *solicitations.Solicitation, force bool) any {
	if options.Delivery == nil || result == nil {
		return nil
	}
	summary, err := options.Delivery.SyncSolicitation(request.Context(), delivery.SyncInput{
		SpaceID: options.SpaceID, PublicID: result.PublicID, Force: force,
		Meta: auth.RequestMetaFromRequest(request, options.TrustProxy),
	})
	if err != nil {
		return nil
	}
	return summary
}

func writeEchoError(response http.ResponseWriter, err error) {
	value := internalError()
	var requirementError *requirements.Error
	var solicitationError *solicitations.Error
	var transportError *publicError
	switch {
	case errors.As(err, &requirementError) && requirementError != nil:
		value = &publicError{Code: requirementError.Code, Message: requirementError.Message, StatusCode: publicStatus(requirementError.StatusCode)}
	case errors.As(err, &solicitationError) && solicitationError != nil:
		value = &publicError{Code: solicitationError.Code, Message: solicitationError.Message, StatusCode: publicStatus(solicitationError.StatusCode)}
	case errors.As(err, &transportError) && transportError != nil:
		value = transportError
	}
	writeJSON(response, value.StatusCode, map[string]any{"error": value})
}
