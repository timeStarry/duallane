package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
)

// CardService is the transport-facing portion of the workspace card service.
// Keeping this interface here lets the router depend on the domain boundary,
// rather than on a concrete repository-backed implementation.
type CardService interface {
	ResolveCard(context.Context, string, string, cards.Request) (cards.Resolution, error)
	ExecuteAction(context.Context, cards.ActionInput) (cards.ActionOutcome, error)
}

func registerCardRoutes(router chi.Router, options RouterOptions) {
	router.Get("/cards/{cardId}", resolveCardHandler(options))
	router.Post("/cards/{cardId}/actions", executeCardActionHandler(options))
}

func resolveCardHandler(options RouterOptions) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if options.Cards == nil {
			writeError(response, &publicError{Code: "card.unavailable", Message: "卡片服务暂不可用", StatusCode: http.StatusServiceUnavailable})
			return
		}
		actor, ok := resolveCardActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		card, err := options.Cards.ResolveCard(request.Context(), actor.ID, chi.URLParam(request, "cardId"), cards.Request{Meta: requestMeta(request, options)})
		writeResult(response, http.StatusOK, map[string]any{"card": card}, err)
	}
}

func executeCardActionHandler(options RouterOptions) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if options.Cards == nil {
			writeError(response, &publicError{Code: "card.unavailable", Message: "卡片服务暂不可用", StatusCode: http.StatusServiceUnavailable})
			return
		}
		actor, ok := resolveCardActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		fields, ok := decodeObjectFields(response, request, "card.invalid_request")
		if !ok {
			return
		}
		expectedRevision, _ := objectFieldInt64(fields, "expectedRevision")
		input := objectFieldAny(fields, "input")
		if input == nil {
			input = map[string]any{}
		}
		result, err := options.Cards.ExecuteAction(request.Context(), cards.ActionInput{
			ActorID: actor.ID, CardID: chi.URLParam(request, "cardId"),
			ActionID: objectFieldString(fields, "actionId"), ClientActionID: objectFieldString(fields, "clientActionId"),
			ExpectedRevision: expectedRevision, Input: input, Meta: requestMeta(request, options),
		})
		writeResult(response, http.StatusOK, map[string]any{"action": result}, err)
	}
}

func resolveCardActor(response http.ResponseWriter, request *http.Request, resolver ActorResolver) (*auth.Actor, bool) {
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

// decodeObjectFields applies the same body-size and JSON framing checks as the
// other Workspace routes, while preserving the Node adapter's object-only
// request contract and unknown-field tolerance.
func decodeObjectFields(response http.ResponseWriter, request *http.Request, code string) (map[string]json.RawMessage, bool) {
	var raw json.RawMessage
	if err := decodeJSON(response, request, &raw); err != nil {
		writeError(response, err)
		return nil, false
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		writeError(response, invalidObjectRequest(code))
		return nil, false
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &fields); err != nil || fields == nil {
		writeError(response, invalidObjectRequest(code))
		return nil, false
	}
	return fields, true
}

func invalidObjectRequest(code string) *publicError {
	return &publicError{Code: code, Message: "请求内容无效", StatusCode: http.StatusBadRequest}
}

func objectFieldString(fields map[string]json.RawMessage, key string) string {
	var value string
	raw, ok := fields[key]
	if !ok || json.Unmarshal(raw, &value) != nil {
		return ""
	}
	return value
}

func objectFieldAny(fields map[string]json.RawMessage, key string) any {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	return value
}

func objectFieldStringSlice(fields map[string]json.RawMessage, key string) []string {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil
	}
	var value []string
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	return value
}

func objectFieldInt64(fields map[string]json.RawMessage, key string) (int64, bool) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return 0, false
	}
	var value int64
	if json.Unmarshal(raw, &value) != nil {
		return 0, false
	}
	return value, true
}

func objectFieldDurationMilliseconds(fields map[string]json.RawMessage, key string) time.Duration {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return 0
	}
	value, ok := objectFieldInt64(fields, key)
	if !ok {
		return -1
	}
	const maxDurationMilliseconds = int64(1<<63-1) / int64(time.Millisecond)
	if value > maxDurationMilliseconds || value < -maxDurationMilliseconds {
		return -1
	}
	return time.Duration(value) * time.Millisecond
}
