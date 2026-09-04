package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/ntfy"
)

type ntfyPreferencesRequest struct {
	Enabled optional[bool] `json:"enabled"`
}

func registerNtfyRoutes(router chi.Router, options RouterOptions) {
	router.Get("/me/ntfy", withActor(options, getNtfyPreferences))
	router.Patch("/me/ntfy", withActor(options, updateNtfyPreferences))
	router.Post("/me/ntfy/rotate", withActor(options, rotateNtfyTopic))
}

func getNtfyPreferences(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Ntfy) {
		return
	}
	preferences, err := options.Ntfy.GetPreferences(request.Context(), actor.ID)
	writeResult(response, http.StatusOK, map[string]any{"ntfy": preferences}, err)
}

func updateNtfyPreferences(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Ntfy) {
		return
	}
	var body ntfyPreferencesRequest
	if !decodeBody(response, request, &body) {
		return
	}
	preferences, err := options.Ntfy.UpdatePreferences(request.Context(), ntfy.UpdatePreferencesInput{
		ActorID: actor.ID, Enabled: body.Enabled.Value, EnabledSet: body.Enabled.Set,
	})
	writeResult(response, http.StatusOK, map[string]any{"ntfy": preferences}, err)
}

func rotateNtfyTopic(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Ntfy) {
		return
	}
	preferences, err := options.Ntfy.RotateTopic(request.Context(), ntfy.RotateTopicInput{ActorID: actor.ID})
	writeResult(response, http.StatusOK, map[string]any{"ntfy": preferences}, err)
}
