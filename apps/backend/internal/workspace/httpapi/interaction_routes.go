package httpapi

import (
	"context"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/interactions"
)

// InteractionService is the transport-facing portion of the command and
// workflow service. The route layer supplies actor, space, and request metadata
// from trusted server context; those values are never accepted from a body.
type InteractionService interface {
	ExecuteCommand(context.Context, interactions.ExecuteCommandInput) (interactions.CommandOutcome, error)
	StartWorkflow(context.Context, interactions.StartWorkflowInput) (interactions.Workflow, error)
	GetWorkflow(context.Context, string, string) (interactions.Workflow, error)
	ContinueWorkflow(context.Context, string, interactions.ContinueWorkflowInput) (interactions.WorkflowOutcome, error)
	CancelWorkflow(context.Context, string, interactions.CancelWorkflowInput) (interactions.Workflow, error)
}

func registerInteractionRoutes(router chi.Router, options RouterOptions) {
	router.Post("/interactions/commands", executeInteractionCommandHandler(options))
	router.Post("/workflows", startWorkflowHandler(options))
	router.Get("/workflows/{workflowId}", getWorkflowHandler(options))
	router.Post("/workflows/{workflowId}/continue", continueWorkflowHandler(options))
	router.Post("/workflows/{workflowId}/cancel", cancelWorkflowHandler(options))
}

func executeInteractionCommandHandler(options RouterOptions) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if !ensureInteractionService(response, options.Interactions) {
			return
		}
		actor, ok := resolveInteractionActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		fields, ok := decodeObjectFields(response, request, "interaction.invalid_request")
		if !ok {
			return
		}
		result, err := options.Interactions.ExecuteCommand(request.Context(), interactions.ExecuteCommandInput{
			ActorID: actor.ID, SpaceID: configuredInteractionSpace(options),
			ConversationID: objectFieldString(fields, "conversationId"), BotUserID: objectFieldString(fields, "botUserId"),
			Source: objectFieldString(fields, "source"), MentionedBotIDs: objectFieldStringSlice(fields, "mentionedBotIds"),
			ClientInvocationID: objectFieldString(fields, "clientInvocationId"), Request: interactions.Request{Meta: requestMeta(request, options)},
		})
		writeResult(response, http.StatusOK, map[string]any{"command": result}, err)
	}
}

func startWorkflowHandler(options RouterOptions) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if !ensureInteractionService(response, options.Interactions) {
			return
		}
		actor, ok := resolveInteractionActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		fields, ok := decodeObjectFields(response, request, "interaction.invalid_request")
		if !ok {
			return
		}
		version, _ := objectFieldInt64(fields, "version")
		result, err := options.Interactions.StartWorkflow(request.Context(), interactions.StartWorkflowInput{
			ActorID: actor.ID, SpaceID: configuredInteractionSpace(options),
			ConversationID: objectFieldString(fields, "conversationId"), BotUserID: objectFieldString(fields, "botUserId"),
			Type: objectFieldString(fields, "type"), Version: int(version), Input: objectFieldAny(fields, "input"),
			TTL: objectFieldDurationMilliseconds(fields, "ttlMs"), ClientInvocationID: objectFieldString(fields, "clientInvocationId"),
			Request: interactions.Request{Meta: requestMeta(request, options)},
		})
		writeResult(response, http.StatusOK, map[string]any{"workflow": result}, err)
	}
}

func getWorkflowHandler(options RouterOptions) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if !ensureInteractionService(response, options.Interactions) {
			return
		}
		actor, ok := resolveInteractionActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		result, err := options.Interactions.GetWorkflow(request.Context(), actor.ID, chi.URLParam(request, "workflowId"))
		writeResult(response, http.StatusOK, map[string]any{"workflow": result}, err)
	}
}

func continueWorkflowHandler(options RouterOptions) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if !ensureInteractionService(response, options.Interactions) {
			return
		}
		actor, ok := resolveInteractionActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		fields, ok := decodeObjectFields(response, request, "interaction.invalid_request")
		if !ok {
			return
		}
		expectedRevision, _ := objectFieldInt64(fields, "expectedRevision")
		result, err := options.Interactions.ContinueWorkflow(request.Context(), actor.ID, interactions.ContinueWorkflowInput{
			WorkflowID: chi.URLParam(request, "workflowId"), ExpectedRevision: expectedRevision,
			Input: objectFieldAny(fields, "input"), Request: interactions.Request{Meta: requestMeta(request, options)},
		})
		writeResult(response, http.StatusOK, result, err)
	}
}

func cancelWorkflowHandler(options RouterOptions) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if !ensureInteractionService(response, options.Interactions) {
			return
		}
		actor, ok := resolveInteractionActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		result, err := options.Interactions.CancelWorkflow(request.Context(), actor.ID, interactions.CancelWorkflowInput{
			WorkflowID: chi.URLParam(request, "workflowId"), SpaceID: configuredInteractionSpace(options),
			Request: interactions.Request{Meta: requestMeta(request, options)},
		})
		writeResult(response, http.StatusOK, map[string]any{"workflow": result}, err)
	}
}

func ensureInteractionService(response http.ResponseWriter, service InteractionService) bool {
	if service != nil {
		return true
	}
	writeError(response, &publicError{Code: "interaction.unavailable", Message: "交互服务暂不可用", StatusCode: http.StatusServiceUnavailable})
	return false
}

func resolveInteractionActor(response http.ResponseWriter, request *http.Request, resolver ActorResolver) (*auth.Actor, bool) {
	actor, ok := resolveActor(response, request, resolver)
	if !ok {
		return nil, false
	}
	if actor == nil {
		writeError(response, auth.NewError(auth.CodeRequired, auth.MessageRequired, http.StatusUnauthorized))
		return nil, false
	}
	return actor, true
}

func configuredInteractionSpace(options RouterOptions) string {
	if value := strings.TrimSpace(options.InteractionSpaceID); value != "" {
		return value
	}
	return auth.DefaultSpaceID
}
