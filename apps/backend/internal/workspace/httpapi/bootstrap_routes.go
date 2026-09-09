package httpapi

import (
	"net/http"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

func bootstrapHandler(options RouterOptions) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, ok := resolveActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		if options.Bootstrap == nil {
			writeError(response, internalError())
			return
		}
		result, err := options.Bootstrap.Get(
			request.Context(), actor.ID, auth.RequestMetaFromRequest(request, options.TrustProxy),
		)
		if err != nil {
			writeError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, result)
	}
}
